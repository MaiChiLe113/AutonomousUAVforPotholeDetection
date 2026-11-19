"""Task queue, report merging, baseline auto-dispatch, chaining, and overrides (docs/fleet-plan.md §7 Phase 3)."""

from __future__ import annotations

import enum
import functools
import json
import threading
from dataclasses import dataclass
from datetime import UTC, datetime

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import (
    FLYING_STATES,
    AppMeta,
    FlightPlan,
    Mission,
    MissionState,
    PlanStatus,
    Report,
    ReportStatus,
)
from app.routers.common import conflict, get_or_404, now_utc, sync_mission
from app.services.allocators import get_allocator
from app.services.fleet import (
    DroneStatus,
    MissionEnd,
    MissionStart,
    get_fleet_state,
    get_mission_start,
    is_drone_offline,
    record_mission_end,
    record_mission_start,
)
from app.services.flight_planner import FlightPlanner, OutOfServiceAreaError
from app.services.safety import SafetyGate, log_decision, mid_flight_check, report_priority
from app.services.simclock import sim_delta, sim_elapsed_s
from config import ENERGY, FLEET, EnergyConfig, FleetConfig
from sim.energy import estimate, haversine_m
from sim.mock_flight import telemetry_at

_TASK_PREFIX = "dispatcher:task:"
_EDGE_FAIL_PREFIX = "dispatcher:edge_fail:"
_PLAN_REPORTS_PREFIX = "dispatcher:plan_reports:"
_SPLICE_BAT_PREFIX = "dispatcher:splice_bat:"

# One tick at a time: the background loop and API requests must not allocate the same task twice.
_TICK_LOCK = threading.RLock()  # re-entrant: recall_mission() ticks again from inside a tick


def _locked(fn):
    """Run `fn` holding the tick lock, so state-changing overrides never interleave with a tick."""

    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        with _TICK_LOCK:
            return fn(*args, **kwargs)

    return wrapper


class TaskStatus(enum.StrEnum):
    queued = "queued"
    held = "held"  # waiting on the ground: the safety gate said no (weather, battery); retried every tick
    dispatched = "dispatched"
    completed = "completed"
    cancelled = "cancelled"
    flagged = "flagged"


@dataclass
class InspectionTask:
    task_id: int
    lat: float
    lon: float
    status: TaskStatus
    created_at: datetime
    queued_at: datetime
    report_ids: list[int]
    drone_id: str | None = None
    plan_id: int | None = None
    mission_id: int | None = None
    retries: int = 0
    decided_by: str = "system"
    failure_reason: str | None = None
    priority: int = 0
    hold_reason: str | None = None
    hold_code: str | None = None


_PENDING = (TaskStatus.queued, TaskStatus.held)


def _utc(dt: datetime) -> datetime:
    return dt.replace(tzinfo=UTC) if dt.tzinfo is None else dt.astimezone(UTC)


def _clear_hold(task: InspectionTask) -> None:
    task.hold_reason = None
    task.hold_code = None


def _task_key(task_id: int) -> str:
    return f"{_TASK_PREFIX}{task_id}"


def _edge_fail_key(mission_id: int) -> str:
    return f"{_EDGE_FAIL_PREFIX}{mission_id}"


def _upsert_meta(db: Session, key: str, value: str) -> None:
    row = db.get(AppMeta, key)
    if row is None:
        db.add(AppMeta(key=key, value=value))
    else:
        row.value = value


def _serialize_task(task: InspectionTask) -> str:
    return json.dumps(
        {
            "task_id": task.task_id,
            "lat": float(task.lat),
            "lon": float(task.lon),
            "status": task.status.value,
            "created_at": _utc(task.created_at).isoformat(),
            "queued_at": _utc(task.queued_at).isoformat(),
            "report_ids": [int(rid) for rid in task.report_ids],
            "drone_id": task.drone_id,
            "plan_id": task.plan_id,
            "mission_id": task.mission_id,
            "retries": int(task.retries),
            "decided_by": task.decided_by,
            "failure_reason": task.failure_reason,
            "priority": int(task.priority),
            "hold_reason": task.hold_reason,
            "hold_code": task.hold_code,
        }
    )


def _deserialize_task(raw: str) -> InspectionTask:
    data = json.loads(raw)
    created_at = _utc(datetime.fromisoformat(data["created_at"]))
    queued_at = _utc(datetime.fromisoformat(data.get("queued_at") or data["created_at"]))
    return InspectionTask(
        task_id=int(data["task_id"]),
        lat=float(data["lat"]),
        lon=float(data["lon"]),
        status=TaskStatus(data["status"]),
        created_at=created_at,
        queued_at=queued_at,
        report_ids=[int(rid) for rid in data["report_ids"]],
        drone_id=data.get("drone_id"),
        plan_id=data.get("plan_id"),
        mission_id=data.get("mission_id"),
        retries=int(data.get("retries", 0)),
        decided_by=str(data.get("decided_by", "system")),
        failure_reason=data.get("failure_reason"),
        priority=int(data.get("priority", 0)),
        hold_reason=data.get("hold_reason"),
        hold_code=data.get("hold_code"),
    )


def save_task(db: Session, task: InspectionTask, *, commit: bool = False) -> InspectionTask:
    _upsert_meta(db, _task_key(task.task_id), _serialize_task(task))
    if commit:
        db.commit()
    else:
        db.flush()
    return task


def get_task(db: Session, task_id: int) -> InspectionTask | None:
    row = db.get(AppMeta, _task_key(task_id))
    return _deserialize_task(row.value) if row is not None else None


def list_tasks(db: Session, status: TaskStatus | None = None) -> list[InspectionTask]:
    rows = db.scalars(select(AppMeta).where(AppMeta.key.like(f"{_TASK_PREFIX}%"))).all()
    tasks = [_deserialize_task(row.value) for row in rows]
    if status is not None:
        tasks = [t for t in tasks if t.status == status]
    tasks.sort(key=lambda t: (t.created_at, t.task_id))
    return tasks


def list_pending_tasks(db: Session) -> list[InspectionTask]:
    """Tasks waiting for a drone: queued, or held on the ground by the safety gate."""
    return [t for t in list_tasks(db) if t.status in _PENDING]


def get_task_for_report(db: Session, report_id: int) -> InspectionTask | None:
    for task in list_tasks(db):
        if report_id in task.report_ids:
            return task
    return None


def get_tasks_for_mission(db: Session, mission_id: int) -> list[InspectionTask]:
    return [task for task in list_tasks(db) if task.mission_id == mission_id]


def get_task_for_mission(db: Session, mission_id: int) -> InspectionTask | None:
    tasks = get_tasks_for_mission(db, mission_id)
    return tasks[0] if tasks else None


def record_plan_reports(db: Session, plan_id: int, report_ids: list[int], *, commit: bool = False) -> list[int]:
    """Store the ordered list of report IDs served by a single- or multi-stop flight plan."""
    unique = list(dict.fromkeys(int(rid) for rid in report_ids))
    _upsert_meta(db, f"{_PLAN_REPORTS_PREFIX}{plan_id}", json.dumps(unique))
    if commit:
        db.commit()
    else:
        db.flush()
    return unique


def get_plan_reports(db: Session, plan_id: int) -> list[int]:
    """Return all report IDs linked to `plan_id`."""
    row = db.get(AppMeta, f"{_PLAN_REPORTS_PREFIX}{plan_id}")
    if row is not None:
        return [int(rid) for rid in json.loads(row.value)]
    plan = db.get(FlightPlan, plan_id)
    return [plan.report_id] if plan is not None else []


def _add_pre_splice_battery(db: Session, mission_id: int, extra_bat_pct: float) -> None:
    key = f"{_SPLICE_BAT_PREFIX}{mission_id}"
    row = db.get(AppMeta, key)
    prev = float(row.value) if row is not None else 0.0
    _upsert_meta(db, key, f"{prev + max(0.0, extra_bat_pct):.4f}")


def get_pre_splice_battery_used(db: Session, mission_id: int) -> float:
    row = db.get(AppMeta, f"{_SPLICE_BAT_PREFIX}{mission_id}")
    return float(row.value) if row is not None else 0.0


def _sync_task_report_statuses(
    db: Session,
    task: InspectionTask,
    status: ReportStatus,
    *,
    review_note: str | None = None,
) -> None:
    for rid in task.report_ids:
        rep = db.get(Report, rid)
        if rep is not None:
            rep.status = status
            if review_note is not None:
                rep.review_note = review_note


def set_mission_edge_failure(
    db: Session,
    mission_id: int,
    reason: str = "Edge processing timed out",
    *,
    commit: bool = True,
) -> None:
    """Schedule a simulated edge failure for `mission_id` when it reaches completion."""
    _upsert_meta(db, _edge_fail_key(mission_id), reason)
    if commit:
        db.commit()
    else:
        db.flush()


def _pop_edge_failure(db: Session, mission_id: int) -> str | None:
    row = db.get(AppMeta, _edge_fail_key(mission_id))
    if row is None:
        return None
    reason = row.value
    db.delete(row)
    return reason


def _fail_mission_edge(
    db: Session,
    mission: Mission,
    t_event: datetime,
    reason: str,
    fleet_cfg: FleetConfig,
    energy_cfg: EnergyConfig,
) -> None:
    m_start = get_mission_start(db, mission, fleet_cfg=fleet_cfg, energy_cfg=energy_cfg)
    est = estimate(
        mission.flight_plan.route,
        start_battery_pct=m_start.battery_pct,
        start_pos=m_start.pos,
        cfg=energy_cfg,
    )
    elapsed_s = (
        max(0.0, sim_elapsed_s(_utc(mission.started_at), t_event, energy_cfg))
        if mission.started_at is not None
        else est.duration_s
    )
    base = (fleet_cfg.base_lat, fleet_cfg.base_lon, fleet_cfg.base_alt_m)
    sample = telemetry_at(
        mission.flight_plan.route,
        elapsed_s,
        mission.flight_plan.drone_id,
        base,
        start_battery_pct=m_start.battery_pct,
        start_pos=m_start.pos,
        energy_cfg=energy_cfg,
    )
    record_mission_end(
        db,
        mission,
        MissionEnd(sample["lat"], sample["lon"], sample["altitude_m"], sample["battery_pct"], recalled=False),
    )
    mission.state = MissionState.failed
    mission.finished_at = t_event
    log_decision(
        db,
        "abort",
        "edge_failure",
        f"{mission.flight_plan.drone_id} aborted: {reason}",
        at=t_event,
        drone_id=mission.flight_plan.drone_id,
        report_id=mission.report_id,
    )

    for task in get_tasks_for_mission(db, mission.id):
        if task.retries < fleet_cfg.max_task_retries:
            task.retries += 1
            task.status = TaskStatus.queued
            task.queued_at = t_event
            task.drone_id = None
            task.plan_id = None
            task.mission_id = None
            task.failure_reason = reason
            _clear_hold(task)
            _sync_task_report_statuses(db, task, ReportStatus.under_review)
        else:
            task.status = TaskStatus.flagged
            task.failure_reason = reason
            _sync_task_report_statuses(
                db, task, ReportStatus.under_review, review_note=f"Flagged for monitor: {reason}"
            )
        save_task(db, task)
    db.flush()


@_locked
def fail_mission_edge(
    db: Session,
    mission_id: int,
    reason: str = "Edge processing timed out",
    now: datetime | None = None,
    *,
    fleet_cfg: FleetConfig = FLEET,
    energy_cfg: EnergyConfig = ENERGY,
) -> Mission:
    """Immediately fail a flying mission due to edge error/timeout and requeue once (S8)."""
    t_now = _utc(now or now_utc())
    mission = get_or_404(db, Mission, mission_id, "Mission")
    if mission.state not in FLYING_STATES:
        raise conflict(f"Mission {mission_id} is {mission.state.value}; only a flying mission can fail")
    _pop_edge_failure(db, mission.id)
    _fail_mission_edge(db, mission, t_now, reason, fleet_cfg, energy_cfg)
    dispatch_tick(db, t_now, fleet_cfg=fleet_cfg, energy_cfg=energy_cfg)
    db.commit()
    db.refresh(mission)
    return mission


def _requeue_mission_task(
    db: Session,
    mission: Mission,
    t_event: datetime,
    *,
    decided_by: str,
    reason: str,
) -> list[InspectionTask]:
    tasks = get_tasks_for_mission(db, mission.id)
    if not tasks:
        fallback = get_task_for_report(db, mission.report_id)
        if fallback is not None:
            tasks = [fallback]
        else:
            report = mission.report
            tasks = [
                InspectionTask(
                    task_id=report.id,
                    lat=report.lat,
                    lon=report.lon,
                    status=TaskStatus.queued,
                    created_at=_utc(report.created_at),
                    queued_at=t_event,
                    report_ids=[report.id],
                    priority=report_priority(report),
                )
            ]
    for task in tasks:
        task.status = TaskStatus.queued
        task.queued_at = t_event
        task.drone_id = None
        task.plan_id = None
        task.mission_id = None
        task.decided_by = decided_by
        task.failure_reason = reason
        _clear_hold(task)
        save_task(db, task)
        _sync_task_report_statuses(db, task, ReportStatus.under_review)
    return tasks


def _handle_offline_flying_missions(
    db: Session,
    now: datetime,
    fleet_cfg: FleetConfig,
    energy_cfg: EnergyConfig,
) -> None:
    active = list(
        db.scalars(
            select(Mission)
            .where(Mission.state.in_(FLYING_STATES), Mission.started_at.is_not(None))
            .order_by(Mission.started_at.asc(), Mission.id.asc())
        ).all()
    )
    base = (fleet_cfg.base_lat, fleet_cfg.base_lon, fleet_cfg.base_alt_m)
    for m in active:
        drone_id = m.flight_plan.drone_id
        if not is_drone_offline(db, drone_id):
            continue
        m_start = get_mission_start(db, m, fleet_cfg=fleet_cfg, energy_cfg=energy_cfg)
        elapsed_s = max(0.0, sim_elapsed_s(_utc(m.started_at), now, energy_cfg)) if m.started_at else 0.0
        sample = telemetry_at(
            m.flight_plan.route,
            elapsed_s,
            drone_id,
            base,
            start_battery_pct=m_start.battery_pct,
            start_pos=m_start.pos,
            energy_cfg=energy_cfg,
        )
        record_mission_end(
            db,
            m,
            MissionEnd(sample["lat"], sample["lon"], sample["altitude_m"], sample["battery_pct"], recalled=True),
        )
        m.state = MissionState.failed
        m.finished_at = now
        log_decision(
            db,
            "abort",
            "offline",
            f"{drone_id} went offline mid-flight",
            at=now,
            drone_id=drone_id,
            report_id=m.report_id,
        )
        _requeue_mission_task(db, m, now, decided_by="system", reason=f"Drone {drone_id} went offline")
        db.flush()


def _mark_tasks_dispatched(
    db: Session,
    tasks_for_bid: list[InspectionTask],
    *,
    drone_id: str,
    plan_id: int,
    mission_id: int,
) -> None:
    for t in tasks_for_bid:
        t.status = TaskStatus.dispatched
        t.drone_id = drone_id
        t.plan_id = plan_id
        t.mission_id = mission_id
        t.decided_by = "system"
        _clear_hold(t)
        save_task(db, t)
        _sync_task_report_statuses(db, t, ReportStatus.uav_dispatched)


def _log_launch(
    db: Session,
    at: datetime,
    drone_id: str,
    tasks: list[InspectionTask],
    battery_pct: float,
    gate: SafetyGate,
    *,
    inserted: bool = False,
) -> None:
    report_ids = [rid for t in tasks for rid in t.report_ids]
    wx = gate.weather
    verb = "Added report" if inserted else "Launched for report"
    log_decision(
        db,
        "launch",
        "go",
        f"{drone_id} {verb} {', '.join(str(r) for r in report_ids)}: battery {battery_pct:.0f}%, "
        f"wind {wx.wind_mps:.1f} m/s, {'rain' if wx.rain else 'no rain'}",
        at=at,
        drone_id=drone_id,
        report_id=report_ids[0] if report_ids else None,
    )


def _update_holds(
    db: Session,
    eligible: list[InspectionTask],
    launched_task_ids: set[int],
    gate: SafetyGate,
    at: datetime,
) -> None:
    """Hold the tasks the gate blocked; release held tasks the gate cleared but that no drone took yet."""
    for task in eligible:
        if task.task_id in launched_task_ids:
            continue
        blocked = gate.blocked(task.task_id)
        if blocked is not None:
            first_time = task.status != TaskStatus.held or task.hold_code != blocked.code
            task.status = TaskStatus.held
            task.hold_reason = blocked.reason
            task.hold_code = blocked.code
            save_task(db, task)
            if first_time:
                log_decision(
                    db,
                    "hold",
                    blocked.code,
                    blocked.reason,
                    at=at,
                    report_id=task.report_ids[0] if task.report_ids else None,
                )
        elif task.status == TaskStatus.held:  # the gate no longer blocks it: it only waits for a drone now
            task.status = TaskStatus.queued
            _clear_hold(task)
            save_task(db, task)


def _allocate_at(
    db: Session,
    t_event: datetime,
    fleet_cfg: FleetConfig,
    energy_cfg: EnergyConfig,
    *,
    allocator: str | None = None,
) -> list[Mission]:
    """Assign eligible queued or held tasks using the configured allocator, behind the safety gate.

    A task the gate blocks (weather, battery) becomes `held` with a reason; it is retried on every tick and
    launches by itself once the gate says go. Every launch and every new hold goes to the decision log."""
    eligible = [t for t in list_pending_tasks(db) if _utc(t.queued_at) <= t_event]
    if not eligible:
        return []

    alloc = get_allocator(allocator or fleet_cfg.allocator)
    fleet = get_fleet_state(db, t_event, fleet_cfg=fleet_cfg, energy_cfg=energy_cfg)
    gate = SafetyGate(db, t_event, fleet_cfg=fleet_cfg, energy_cfg=energy_cfg)
    winning_bids = alloc.allocate(db, eligible, fleet, t_event, fleet_cfg=fleet_cfg, energy_cfg=energy_cfg, gate=gate)

    planner = FlightPlanner(energy=energy_cfg, fleet=fleet_cfg)
    by_id = {t.task_id: t for t in eligible}
    dispatched: list[Mission] = []
    launched_task_ids: set[int] = set()

    for bid in winning_bids:
        if bid.free_in_s > 0.0:
            continue
        task_ids = list(bid.grouped_task_ids) if bid.grouped_task_ids else [bid.task_id]
        tasks_for_bid = [by_id[tid] for tid in task_ids if tid in by_id]
        if not tasks_for_bid:
            continue
        targets = list(bid.ordered_targets) if bid.ordered_targets else [(t.lat, t.lon) for t in tasks_for_bid]

        if bid.insert_into_mission_id is not None:
            mission = db.get(Mission, bid.insert_into_mission_id)
            if mission is None:
                continue
            prev_start = get_mission_start(db, mission, fleet_cfg=fleet_cfg, energy_cfg=energy_cfg)
            _add_pre_splice_battery(db, mission.id, prev_start.battery_pct - bid.start_battery_pct)
            new_prop = planner.propose_multi(
                targets,
                drone_id=bid.drone_id,
                start_pos=bid.start_pos,
                start_battery_pct=bid.start_battery_pct,
                return_to_home=False,
            )
            mission.flight_plan.route = list(new_prop.route)
            mission.started_at = t_event
            record_mission_start(
                db,
                mission,
                MissionStart(bid.start_pos[0], bid.start_pos[1], bid.start_pos[2], bid.start_battery_pct),
            )
            combined_reports = get_plan_reports(db, mission.flight_plan_id) + [
                rid for t in tasks_for_bid for rid in t.report_ids
            ]
            record_plan_reports(db, mission.flight_plan_id, combined_reports)
            _mark_tasks_dispatched(
                db,
                tasks_for_bid,
                drone_id=bid.drone_id,
                plan_id=mission.flight_plan_id,
                mission_id=mission.id,
            )
            _log_launch(db, t_event, bid.drone_id, tasks_for_bid, bid.start_battery_pct, gate, inserted=True)
            launched_task_ids.update(t.task_id for t in tasks_for_bid)
            db.flush()
            if mission not in dispatched:
                dispatched.append(mission)
            continue

        proposal = planner.propose_multi(
            targets,
            drone_id=bid.drone_id,
            start_pos=bid.start_pos,
            start_battery_pct=bid.start_battery_pct,
            return_to_home=False,
        )
        plan = FlightPlan(
            report_id=tasks_for_bid[0].task_id,
            drone_id=bid.drone_id,
            altitude_m=proposal.altitude_m,
            survey_radius_m=proposal.survey_radius_m,
            route=list(proposal.route),
            status=PlanStatus.approved,
            decision_reason="Approved by system",
            decided_at=t_event,
        )
        db.add(plan)
        db.flush()

        mission = Mission(
            flight_plan_id=plan.id,
            report_id=tasks_for_bid[0].task_id,
            state=MissionState.takeoff,
            started_at=t_event,
        )
        db.add(mission)
        db.flush()

        record_mission_start(
            db,
            mission,
            MissionStart(bid.start_pos[0], bid.start_pos[1], bid.start_pos[2], bid.start_battery_pct),
        )
        record_plan_reports(db, plan.id, [rid for t in tasks_for_bid for rid in t.report_ids])
        _mark_tasks_dispatched(
            db,
            tasks_for_bid,
            drone_id=bid.drone_id,
            plan_id=plan.id,
            mission_id=mission.id,
        )
        _log_launch(db, t_event, bid.drone_id, tasks_for_bid, bid.start_battery_pct, gate)
        launched_task_ids.update(t.task_id for t in tasks_for_bid)
        db.flush()
        dispatched.append(mission)

    _update_holds(db, eligible, launched_task_ids, gate, t_event)
    return dispatched


def _complete_tasks_of_finished_missions(db: Session) -> None:
    """Close dispatched tasks whose mission is already done.

    The tick loop below closes a task when it finishes the mission itself, but reads (GET /fleet, /reports,
    /missions via sync_mission) and POST /missions/{id}/results can finish a mission first; the loop then
    never sees it as flying and the task would stay "dispatched" forever."""
    for task in list_tasks(db, TaskStatus.dispatched):
        if task.mission_id is None:
            continue
        mission = db.get(Mission, task.mission_id)
        if mission is None or mission.state != MissionState.done:
            continue
        task.status = TaskStatus.completed
        save_task(db, task)
        _sync_task_report_statuses(db, task, mission.report.status)


def dispatch_tick(
    db: Session,
    now: datetime | None = None,
    *,
    allocator: str | None = None,
    fleet_cfg: FleetConfig = FLEET,
    energy_cfg: EnergyConfig = ENERGY,
    weather_check: bool = True,
) -> list[Mission]:
    """Advance active missions, handle offline/edge failures, recall in bad weather, chain returning drones,
    and dispatch queued or held tasks (behind the safety gate).

    `weather_check=False` skips the mid-flight recall check (used by the tick nested inside a recall)."""
    with _TICK_LOCK:
        return _dispatch_tick(
            db, now, allocator=allocator, fleet_cfg=fleet_cfg, energy_cfg=energy_cfg, weather_check=weather_check
        )


def _dispatch_tick(
    db: Session,
    now: datetime | None,
    *,
    allocator: str | None,
    fleet_cfg: FleetConfig,
    energy_cfg: EnergyConfig,
    weather_check: bool,
) -> list[Mission]:
    t_now = _utc(now or now_utc())
    dispatched: list[Mission] = []

    _complete_tasks_of_finished_missions(db)
    _handle_offline_flying_missions(db, t_now, fleet_cfg, energy_cfg)
    if weather_check:
        mid_flight_check(db, t_now, fleet_cfg=fleet_cfg, energy_cfg=energy_cfg)

    while True:
        active = list(
            db.scalars(
                select(Mission)
                .where(Mission.state.in_(FLYING_STATES), Mission.started_at.is_not(None))
                .order_by(Mission.started_at.asc(), Mission.id.asc())
            ).all()
        )
        ready_missions: list[tuple[datetime, Mission]] = []
        for m in active:
            assert m.started_at is not None
            m_start = get_mission_start(db, m, fleet_cfg=fleet_cfg, energy_cfg=energy_cfg)
            est = estimate(
                m.flight_plan.route,
                start_battery_pct=m_start.battery_pct,
                start_pos=m_start.pos,
                cfg=energy_cfg,
            )
            m_end = _utc(m.started_at) + sim_delta(est.duration_s, energy_cfg)
            if m_end <= t_now:
                ready_missions.append((m_end, m))
        ready_missions.sort(key=lambda pair: (pair[0], pair[1].id))
        earliest_m_end, earliest_m = ready_missions[0] if ready_missions else (None, None)

        queued = [t for t in list_pending_tasks(db) if _utc(t.queued_at) <= t_now]
        avail_times: list[datetime] = []
        if queued:
            probe_t = min(_utc(t.queued_at) for t in queued)
            for drone in get_fleet_state(db, probe_t, fleet_cfg=fleet_cfg, energy_cfg=energy_cfg):
                if (
                    drone.status in (DroneStatus.returning, DroneStatus.swapping)
                    and drone.available_at <= t_now
                    and (earliest_m_end is None or drone.available_at < earliest_m_end)
                ):
                    avail_times.append(drone.available_at)

        allocated_before_mission = False
        for avail_t in sorted(set(avail_times)):
            dispatched_here = _allocate_at(db, avail_t, fleet_cfg, energy_cfg, allocator=allocator)
            if dispatched_here:
                dispatched.extend(dispatched_here)
                allocated_before_mission = True
                break
        if allocated_before_mission:
            continue

        if earliest_m_end is not None and earliest_m is not None:
            edge_reason = _pop_edge_failure(db, earliest_m.id)
            if edge_reason is not None:
                _fail_mission_edge(db, earliest_m, earliest_m_end, edge_reason, fleet_cfg, energy_cfg)
            else:
                sync_mission(db, earliest_m, earliest_m_end)
                for task in get_tasks_for_mission(db, earliest_m.id):
                    task.status = TaskStatus.completed
                    save_task(db, task)
                    _sync_task_report_statuses(db, task, earliest_m.report.status)
            dispatched.extend(_allocate_at(db, earliest_m_end, fleet_cfg, energy_cfg, allocator=allocator))
            continue

        dispatched.extend(_allocate_at(db, t_now, fleet_cfg, energy_cfg, allocator=allocator))
        break

    db.commit()
    return dispatched


@_locked
def enqueue_report(
    db: Session,
    report_or_id: Report | int,
    now: datetime | None = None,
    *,
    auto_dispatch: bool = True,
    allocator: str | None = None,
    fleet_cfg: FleetConfig = FLEET,
    energy_cfg: EnergyConfig = ENERGY,
) -> InspectionTask:
    """Turn a confirmed report into a queued task (merging into an open task within `report_merge_radius_m`)."""
    report = report_or_id if isinstance(report_or_id, Report) else get_or_404(db, Report, report_or_id, "Report")
    if report.status in (ReportStatus.no_damage, ReportStatus.rejected):
        raise conflict(f"Report {report.id} is {report.status.value} and cannot be queued")

    dist_from_base = haversine_m((fleet_cfg.base_lat, fleet_cfg.base_lon), (report.lat, report.lon))
    if dist_from_base > fleet_cfg.service_radius_m + fleet_cfg.area_epsilon_m:
        raise OutOfServiceAreaError(
            f"Target ({report.lat:.5f}, {report.lon:.5f}) is {dist_from_base:.0f} m from base, "
            f"outside the {fleet_cfg.service_radius_m:.0f} m service area"
        )

    existing = get_task_for_report(db, report.id)
    if existing is not None:
        return existing

    open_tasks = [t for t in list_tasks(db) if t.status in (*_PENDING, TaskStatus.dispatched)]
    nearby: list[tuple[float, InspectionTask]] = []
    for t in open_tasks:
        d = haversine_m((t.lat, t.lon), (report.lat, report.lon))
        if d <= fleet_cfg.report_merge_radius_m:
            nearby.append((d, t))
    if nearby:
        nearby.sort(key=lambda pair: (pair[0], pair[1].created_at, pair[1].task_id))
        target_task = nearby[0][1]
        if report.id not in target_task.report_ids:
            target_task.report_ids.append(report.id)
        target_task.priority = max(target_task.priority, report_priority(report))
        if target_task.status == TaskStatus.dispatched:
            report.status = ReportStatus.uav_dispatched
        save_task(db, target_task, commit=True)
        return target_task

    t_now = _utc(now or now_utc())
    task = InspectionTask(
        task_id=report.id,
        lat=report.lat,
        lon=report.lon,
        status=TaskStatus.queued,
        created_at=t_now,
        queued_at=t_now,
        report_ids=[report.id],
        priority=report_priority(report),
    )
    save_task(db, task, commit=not auto_dispatch)
    if auto_dispatch:
        dispatch_tick(db, t_now, allocator=allocator, fleet_cfg=fleet_cfg, energy_cfg=energy_cfg)
        return get_task(db, task.task_id) or task
    return task


@_locked
def cancel_task(
    db: Session,
    task_or_report_id: int,
    reason: str = "Cancelled by monitor",
) -> InspectionTask:
    """Monitor override: cancel a queued inspection task and close its reports as rejected."""
    task = get_task(db, task_or_report_id) or get_task_for_report(db, task_or_report_id)
    if task is None:
        raise HTTPException(status_code=404, detail=f"Inspection task {task_or_report_id} not found")
    if task.status not in _PENDING:
        raise conflict(f"Task {task.task_id} is {task.status.value}; only a queued or held task can be cancelled")
    task.status = TaskStatus.cancelled
    task.decided_by = "monitor"
    task.failure_reason = reason
    _clear_hold(task)
    save_task(db, task)
    _sync_task_report_statuses(db, task, ReportStatus.rejected, review_note=reason)
    db.commit()
    return task


@_locked
def recall_mission(
    db: Session,
    mission_id: int,
    reason: str = "Recalled by monitor",
    now: datetime | None = None,
    *,
    fleet_cfg: FleetConfig = FLEET,
    energy_cfg: EnergyConfig = ENERGY,
    code: str = "monitor_recall",
    action: str = "recall",
) -> Mission:
    """Recall a flying drone, return it to base, and requeue/reassign its task (S7).

    Called by the monitor (default) and by `safety.mid_flight_check` (`code` = the weather reason)."""
    t_now = _utc(now or now_utc())
    mission = get_or_404(db, Mission, mission_id, "Mission")
    if mission.state not in FLYING_STATES or mission.started_at is None:
        raise conflict(f"Mission {mission_id} is {mission.state.value}; only a flying mission can be recalled")

    m_start = get_mission_start(db, mission, fleet_cfg=fleet_cfg, energy_cfg=energy_cfg)
    est = estimate(
        mission.flight_plan.route,
        start_battery_pct=m_start.battery_pct,
        start_pos=m_start.pos,
        cfg=energy_cfg,
    )
    elapsed_s = max(0.0, sim_elapsed_s(_utc(mission.started_at), t_now, energy_cfg))
    if elapsed_s >= est.duration_s - energy_cfg.time_epsilon_s:
        raise conflict(f"Mission {mission_id} has already finished flying")

    base = (fleet_cfg.base_lat, fleet_cfg.base_lon, fleet_cfg.base_alt_m)
    sample = telemetry_at(
        mission.flight_plan.route,
        elapsed_s,
        mission.flight_plan.drone_id,
        base,
        start_battery_pct=m_start.battery_pct,
        start_pos=m_start.pos,
        energy_cfg=energy_cfg,
    )
    record_mission_end(
        db,
        mission,
        MissionEnd(sample["lat"], sample["lon"], sample["altitude_m"], sample["battery_pct"], recalled=True),
    )
    mission.state = MissionState.failed
    mission.finished_at = t_now
    mission.flight_plan.decision_reason = reason
    log_decision(
        db,
        action,
        code,
        f"{mission.flight_plan.drone_id} recalled: {reason}",
        at=t_now,
        drone_id=mission.flight_plan.drone_id,
        report_id=mission.report_id,
    )

    _requeue_mission_task(
        db, mission, t_now, decided_by="monitor" if code == "monitor_recall" else "system", reason=reason
    )
    dispatch_tick(db, t_now, fleet_cfg=fleet_cfg, energy_cfg=energy_cfg, weather_check=False)
    db.commit()
    db.refresh(mission)
    return mission
