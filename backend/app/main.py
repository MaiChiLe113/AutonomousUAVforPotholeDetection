"""FastAPI app factory. Start with `python -m run.serve`."""

from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from app.db import SessionLocal, init_db
from app.routers import detections, dev, fleet, flight_plans, missions, monitoring, reports, telemetry
from config import API, FLEET, MOCK, PATHS

logger = logging.getLogger(__name__)


def _build_detector():
    """MockDetector while MOCK.enabled. The real server model is still a TODO, so uploads answer 501."""
    if MOCK.enabled:
        from app.services.mock_detector import MockDetector

        return MockDetector()
    # TODO(SCRUM-29, Hai): detector = build_detector(); detector.load(); return detector
    return None


def tick_once() -> int:
    """One autonomous dispatch pass in its own session; returns how many missions it launched."""
    from app.services.dispatcher import dispatch_tick

    with SessionLocal() as db:
        return len(dispatch_tick(db))


async def _tick_loop(interval_s: float) -> None:
    """Background autonomy: the fleet decides when to fly without any request (FLEET.tick_interval_s)."""
    while True:
        await asyncio.sleep(interval_s)
        try:
            await asyncio.to_thread(tick_once)
        except Exception:  # keep the loop alive: one bad tick must not stop the fleet
            logger.exception("dispatch tick failed")


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    if MOCK.enabled:
        from app.mock_seed import seed_on_start

        with SessionLocal() as db:
            seed_on_start(db)  # seeds a missing/empty database only; restarts keep the demo data
    app.state.detector = _build_detector()
    ticker = asyncio.create_task(_tick_loop(FLEET.tick_interval_s)) if FLEET.auto_tick else None
    app.state.ticker = ticker  # None when FLEET.auto_tick is off (tests)
    try:
        yield
    finally:
        if ticker is not None:
            ticker.cancel()
            await asyncio.gather(ticker, return_exceptions=True)


async def _validation_error(request: Request, exc: RequestValidationError) -> JSONResponse:
    """422 with `detail` as one readable string (the frontend shows it as is) plus the raw `errors`."""
    parts = []
    for err in exc.errors():
        where = ".".join(str(p) for p in err.get("loc", ()) if p not in ("body", "query", "path", "form"))
        parts.append(f"{where}: {err.get('msg')}" if where else str(err.get("msg")))
    content = {"detail": "; ".join(parts) or "Invalid request", "errors": jsonable_encoder(exc.errors())}
    return JSONResponse(status_code=422, content=content)


def create_app() -> FastAPI:
    PATHS.media_dir.mkdir(parents=True, exist_ok=True)

    app = FastAPI(title="Pothole UAV API", version="0.1.0", lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(API.cors_origins),
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.add_exception_handler(RequestValidationError, _validation_error)
    app.mount("/media", StaticFiles(directory=PATHS.media_dir), name="media")

    for module in (reports, detections, flight_plans, missions, telemetry, monitoring, fleet, dev):
        app.include_router(module.router)

    @app.get("/health", tags=["health"])
    def health() -> dict[str, str]:
        return {"status": "ok"}

    return app


app = create_app()
