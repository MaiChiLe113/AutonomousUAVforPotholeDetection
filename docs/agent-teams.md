# Using Claude agent teams in this repo

Agent teams let one Claude Code session (the **lead**) start several other Claude sessions
(**teammates**). Each teammate has its own context, they share a task list, and they can message
each other. It is an experimental feature (this machine has Claude Code v2.1.318).

Official docs: https://code.claude.com/docs/en/agent-teams

## What is already set up

| File | What it does |
|---|---|
| `.claude/settings.json` | Turns on `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` for everyone who opens this repo, and pre-approves safe commands (git status/diff, ruff, pytest, npm lint/build) so teammates ask for fewer permissions. Blocks reading `.env` files. |
| `.claude/agents/*.md` | Five reusable teammate roles (below). |
| `CLAUDE.md` | Project rules. Every teammate loads it at start. |
| `.gitignore` | Now commits `.claude/settings.json`, `.claude/agents/` and `.claude/launch.json`; still ignores worktrees and `settings.local.json`. |

### Teammate roles

| Agent type | Owns | Notes |
|---|---|---|
| `backend-api` | `backend/app/` routers, models, schemas, db; `tests/test_api.py` | Tells `frontend` when schemas change |
| `ml-pipeline` | `backend/ml/`, `backend/run/`, `services/detector.py`, ML config | Will not start full training or downloads unless asked |
| `frontend` | `frontend/` | Keeps `lib/types.ts` in sync with `schemas.py` |
| `uav-sim` | `backend/sim/`, `backend/edge/`, `ml/export.py`, flight plans, missions | Guards Jetson/Pi-only imports |
| `reviewer` | read-only | Reports findings with severity and `file:line` |

Each role edits only its own files. That is what stops two teammates overwriting the same file.

## 1. Start a session

Agent teams work best in the terminal CLI, where you get the agent panel:

```bash
cd "/Users/quang/code/SmartCityUAVforPotholeDetection copy"
```

```bash
claude
```

The setting is read from `.claude/settings.json`, so nothing else is needed. (It also works in the
Claude desktop app, but the keyboard controls below are for the CLI.)

## 2. Ask for a team

Say what you want and which roles to use. Name them so you can refer to them later.

**Review (good first try, no code changes):**
```text
Create an agent team to review the backend. Spawn three teammates:
- "sec" using the reviewer agent type: security of upload handling in app/routers/reports.py
- "sync" using the reviewer agent type: compare backend/app/schemas.py with frontend/lib/types.ts
- "cfg" using the reviewer agent type: find hard-coded values that belong in config.py
Collect their findings into one list sorted by severity.
```

**Build a feature across layers:**
```text
Create an agent team to implement SCRUM-23 (resident report create/list/get).
Spawn "api" using backend-api, "web" using frontend, and "rev" using reviewer.
api implements the endpoints in app/routers/reports.py with tests.
web wires /report and /monitor pages to lib/api.ts.
rev reviews each finished task. Require plan approval before api and web edit files.
```

**Debug with competing ideas:**
```text
The simulated mission never reaches "completed". Spawn 3 teammates with different
hypotheses (flight_planner, sim/uav.py state machine, missions router). Have them
try to disprove each other and report the cause they agree on.
```

**Pick a cheaper model:**
```text
Spawn 3 reviewer teammates using Sonnet to ...
```

## 3. Control the team (CLI, in-process mode)

| Key | Action |
|---|---|
| ↑ / ↓ | Select a teammate in the agent panel under the prompt |
| Enter | Open that teammate's transcript; type to message it directly |
| Esc | Leave the selection. While viewing a teammate, Esc interrupts its current turn |
| `x` | Stop the selected teammate |
| Ctrl+T | Show / hide the shared task list |
| Shift+Tab | Change the permission mode of the teammate you are viewing |

Useful things to tell the lead:
- `Wait for your teammates to complete their tasks before proceeding` (if the lead starts doing the work itself)
- `Split that into smaller tasks` (aim for 5-6 tasks per teammate)
- `Ask web to shut down` (stop one teammate by name)
- `Task X looks stuck, check if it's done and update it`

Permission prompts from teammates appear in the lead's window. Approve them there.

## 4. Optional: split panes

By default all teammates run inside one terminal. To see each in its own pane you need tmux
(not installed on this Mac) or iTerm2 with the `it2` CLI:

```bash
brew install tmux
```

Then add `"teammateMode": "auto"` to `~/.claude/settings.json`, or start one session with:

```bash
claude --teammate-mode tmux
```

In iTerm2, `tmux -CC` is the recommended way in.

## 5. Tips and limits

- **Start with 3 teammates.** Tokens scale with each teammate; more is rarely faster.
- **Use teams for parallel work only**: reviews, research, separate layers. For one small change,
  a normal session is cheaper.
- **Give context in the spawn prompt.** Teammates read `CLAUDE.md` but not your chat with the lead.
- **One team per session.** Teammates cannot start their own teammates.
- **`/resume` does not bring teammates back.** Ask the lead to spawn new ones.
- **Task status can lag.** If a task looks stuck, check the work and tell the lead.
- When agent teams are on, Claude may also turn named helper agents into teammates by itself.
  To turn the feature off for yourself, put this in `.claude/settings.local.json`:

  ```json
  { "env": { "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "0" } }
  ```

## Add or change a role

Create `.claude/agents/<name>.md`:

```markdown
---
name: test-runner
description: Runs backend and frontend checks and reports failures.
tools: Read, Grep, Glob, Bash
model: sonnet
---

Instructions for the teammate go here.
```

Then: `Spawn a teammate using the test-runner agent type to ...`
