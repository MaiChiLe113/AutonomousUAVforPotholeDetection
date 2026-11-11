# CLAUDE.md

Smart City UAV for Pothole Detection (COS40007, Group 1). Full setup and commands: `README.md`.
Agent teams guide: `docs/agent-teams.md`.

## Layout
- `backend/` Python 3.11: `config.py` (all values), `ml/` (pipeline, `build.py`), `run/` (entry points),
  `app/` (FastAPI routers + services), `sim/` (UAV sim), `edge/` (Jetson/Pi), `tests/`
- `frontend/` Next.js 15 App Router: `lib/config.ts` (all values), `lib/api.ts`, `lib/types.ts`, `app/`, `components/`

## Rules
- Values go in `backend/config.py` or `frontend/lib/config.ts`; logic in `ml/ app/ sim/ edge/`; `run/` only wires build functions.
- Secrets live in `.env` files, never in code. Do not read or print `.env` files.
- `backend/app/schemas.py` and `frontend/lib/types.ts` change together.
- Stubs raise `todo("SCRUM-xx ...")` / `NotImplementedError("TODO(SCRUM-xx, owner)")`. Keep the Jira key; remove the test `xfail` when implemented.
- One branch per Jira issue (`SCRUM-24`). `main` is protected.

## Checks
- Backend (from `backend/`, venv active): `ruff check . && pytest`
- Frontend (from `frontend/`): `npm run lint && npm run build`

## Agent teams
Teammate roles live in `.claude/agents/` (backend-api, ml-pipeline, frontend, uav-sim, reviewer).
Each teammate edits only its own files; ask the owning teammate for changes elsewhere.
