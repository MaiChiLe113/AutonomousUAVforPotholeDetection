# Team kickoff: prototype

How to start the agent team that builds the prototype in `docs/prototype-plan.md`.

## 1. Open Claude in the main folder

```bash
cd "/Users/quang/code/SmartCityUAVforPotholeDetection copy"
```

```bash
claude
```

Tip: press Shift+Tab to switch to "accept edits" mode so teammates don't ask before every file edit.
Permission prompts from teammates appear in this (lead) window.

## 2. Paste this prompt

```text
Read docs/prototype-plan.md and run it as an agent team. You are the lead: do not write code yourself.
Rules: no tests (skip pytest; only ruff check . and npm run lint && npm run build as compile checks),
light theme only, no settings/profile menus, each teammate edits only the files the plan gives it.
Phase 1: spawn analyst (analyst type), api (backend-api), sim (uav-sim), ui-core (frontend) with their plan sections.
Phase 2, when ui-core and api are done: spawn resident and monitor (frontend); keep api for contract fixes;
shut down the others. Phase 3: spawn rev (reviewer) to check every use case in docs/use-cases.md and the
compile checks; send fixes to the owners. Wait for teammates; report to me at the end of each phase.
```

## 3. While it runs

| Key | Action |
|---|---|
| ↑ / ↓ then Enter | Open a teammate and message it |
| Esc | Back to the lead / interrupt the teammate you are viewing |
| Ctrl+T | Show the shared task list |

Useful messages to the lead:
- `Wait for your teammates to complete their tasks before proceeding`
- `Show me the task list status`

## 4. Try the prototype after phase 3

```bash
cd backend && .venv/bin/pip install -e ".[dev]" && .venv/bin/python -m run.serve --reload
```

```bash
cd frontend && npm run dev
```

Open http://localhost:3000, sign in as Resident, report a pothole, switch to Monitor, review it,
approve the flight plan, launch the UAV and watch the result. API docs: http://localhost:8000/docs
