from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.main import create_app

_MEDIA = Path(__file__).resolve().parents[1] / "mock" / "media"
MONITOR = {"X-Role": "monitor"}

# Every control endpoint: residents (no header, or any other role) get 403 before anything else happens.
_CONTROL = [
    ("post", "/missions/1/dispatch"),
    ("post", "/missions/1/recall"),
    ("post", "/reports/1/cancel"),
    ("post", "/reports/1/enqueue"),
    ("post", "/reports/1/flight-plan"),
    ("post", "/dispatcher/tick"),
    ("post", "/flight-plans/1/approve"),
    ("post", "/flight-plans/1/reject"),
    ("post", "/flight-plans/1/request-changes"),
    ("patch", "/reports/1/review"),
    ("post", "/dev/reset"),
    ("post", "/detections/1/flag"),
    ("post", "/missions/1/camera/request"),
    ("post", "/missions/1/camera/stop"),
]


def test_health():
    with TestClient(create_app()) as client:
        assert client.get("/health").json() == {"status": "ok"}


@pytest.mark.parametrize("headers", [{}, {"X-Role": "resident"}, {"X-Role": ""}])
@pytest.mark.parametrize(("method", "path"), _CONTROL)
def test_control_endpoints_refuse_residents(method: str, path: str, headers: dict):
    with TestClient(create_app()) as client:
        res = client.request(method, path, headers=headers, json={})
        assert res.status_code == 403
        assert "monitor" in res.json()["detail"]


def test_monitor_role_is_accepted_case_insensitively():
    with TestClient(create_app()) as client:
        assert client.post("/dispatcher/tick", headers={"X-Role": "Monitor"}).status_code == 200


def test_residents_keep_report_creation_and_all_reads():
    with TestClient(create_app()) as client:
        assert client.post("/dev/reset", headers=MONITOR).status_code == 200
        with (_MEDIA / "pothole-1.jpg").open("rb") as photo:
            res = client.post(
                "/reports",
                data={"lat": "10.7800", "lon": "106.7030"},
                files={"photo": ("pothole-1.jpg", photo, "image/jpeg")},
                headers={"X-Role": "resident"},
            )
        assert res.status_code == 201
        for path in ("/reports", f"/reports/{res.json()['id']}", "/missions", "/fleet", "/monitoring/metrics"):
            assert client.get(path, headers={"X-Role": "resident"}).status_code == 200, path


def test_resident_cannot_review_even_with_a_valid_report():
    with TestClient(create_app()) as client:
        assert client.post("/dev/reset", headers=MONITOR).status_code == 200
        res = client.patch("/reports/1/review", json={"confirmed": True}, headers={"X-Role": "resident"})
        assert res.status_code == 403
        assert client.get("/reports/1").json()["status"] == "under_review"  # unchanged
