"""Demo-grade role check: the `X-Role` header must say "monitor" for control endpoints.

This is NOT authentication: any client can send the header. It stops residents' UI and casual calls from
dispatching, recalling, cancelling, reviewing or resetting, and marks where real auth (tokens) goes later.
"""

from __future__ import annotations

from fastapi import Header, HTTPException

from config import API


def require_monitor(x_role: str | None = Header(default=None, alias=API.role_header)) -> str:
    """FastAPI dependency: 403 unless the role header is the monitor role."""
    if (x_role or "").strip().lower() != API.monitor_role:
        raise HTTPException(status_code=403, detail=f"This action needs the {API.monitor_role} role")
    return API.monitor_role
