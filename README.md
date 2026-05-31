# Loomer — From PRD to Code, Automated

Loomer is an open-source AI coding agent orchestrator. Starting from a PRD, it automatically splits tasks, schedules them in parallel via DAG, performs risk-tiered review, and auto-merges/creates PRs.

**Core metaphor:** A loom — the PRD is the warp, agents are the weft, the DAG is the weaving pattern, and the review gate is the quality checkpoint.

## Relationship to Conductor-UI

Loomer is a Node.js rewrite of [conductor-ui](https://github.com/WillBrennan/conductor-ui) (Python, 2,657 lines of core code), with key architectural improvements:

| Dimension | Conductor-UI | Loomer |
|-----------|-------------|--------|
| Entry point | Manual agent creation | PRD auto-split → DAG scheduling |
| Review | Human reads all diffs | Risk signals auto-classify; humans only review HIGH |
| Platform | macOS only | macOS + Linux |
| License | Closed source | Fully open source |
| Pipeline | None | `/prd` → prd.json → `loomer plan run --prd` → DAG → review → merge/PR |

## Key Features

### PRD-Driven DAG Parallel Scheduling

Define tasks in `prd.json` — Loomer parses it, validates the dependency graph (no cycles, no missing references), and schedules independent tasks in parallel up to `maxConcurrent`. When a task completes, downstream dependents are immediately unlocked.

```
PRD → /prd skill → prd.json → loomer plan run --prd prd.json → DAG validation → parallel scheduling → risk review → merge/PR
```

### Risk-Tiered Review

Six risk signals are automatically evaluated before merge:

| Signal | HIGH Condition |
|--------|---------------|
| `file_count` | Changed files > `maxFiles` (default 5) |
| `line_count` | Changed lines > `maxLines` (default 200) |
| `new_files` | New files created |
| `public_modules` | Shared modules modified (paths containing `lib/`, `core/`, `src/`) |
| `conflict` | Merge conflict detected |
| `test` | Code changed but no test files modified |

Any signal HIGH → overall HIGH → enters REVIEW (requires human accept/reject). All LOW → auto-merge → ACCEPTED.

Three merge strategies: `auto` (default), `always` (all REVIEW), `never` (all ACCEPTED).

### Auto-Done

When an agent process exits (exit_code=0), Loomer automatically triggers the `done()` flow: risk assessment → merge → classification → cleanup. No human intervention needed for LOW-risk changes.

### Merge Conflict Auto-Resolution

When merge conflicts occur, Loomer attempts automatic resolution by file type before escalating to humans:

| File Type | Strategy |
|-----------|----------|
| `package.json` | Merge dependencies (union of both sides) |
| `src/*.ts` source | Concatenate import/export/class sections (ours first, theirs after) |
| `*config*` files | Deep merge (ours as base, overlay theirs' new keys) |
| Others | No auto-resolution → CONFLICTED (preserved for manual fix) |

Auto-resolved changes must pass validation (`tsc --noEmit` / `biome check` / `vitest run`) before commit. Failed validation → rollback → CONFLICTED.

### Resident Main Process Architecture

Loomer uses SQLite WAL mode for state persistence, enabling CLI and Web to share the same state store across processes. The event-loop single-thread model eliminates the need for threading locks — SQLite transactions handle cross-process atomicity natively.

## Architecture

```
┌──────────────────────────────────────────────────────┐
│                      CLI (Commander.js)               │
│  start / done / kill / retry / accept / reject / ... │
└──────────────────┬───────────────────────────────────┘
                   │
┌──────────────────▼───────────────────────────────────┐
│                  LoomerApp (Core Orchestrator)         │
│  ┌───────────┐ ┌──────────────┐ ┌────────────────┐  │
│  │ Workspace │ │ SafetyChecks │ │ ProcessManager │  │
│  │  Manager  │ │ (Risk Tier)  │ │ (spawn+pipe)   │  │
│  └───────────┘ └──────────────┘ └────────────────┘  │
│  ┌───────────┐ ┌──────────────┐ ┌────────────────┐  │
│  │   State   │ │    Status    │ │  PlanParser +  │  │
│  │  Store    │ │  Detector    │ │  PlanExecutor   │  │
│  │ (SQLite)  │ │ (9 States)  │ │  (DAG Schedule) │  │
│  └───────────┘ └──────────────┘ └────────────────┘  │
└──────────────────┬───────────────────────────────────┘
                   │
┌──────────────────▼───────────────────────────────────┐
│           Express Web + SSE (Real-time Dashboard)     │
│  REST API: /api/status, /api/start, /api/done, ...    │
│  SSE: /api/events (push-only-changes + heartbeat)     │
└──────────────────────────────────────────────────────┘
```

## State Machine

9 states with strict detection priority:

```
PENDING ──start()──→ RUNNING
                      │
                      ├── timeout ──→ STALE ──kill()──→ DONE
                      │                        ──retry()──→ RUNNING
                      │
                      ├── exit_code=0 ──→ DONE ──done()──→ risk_check
                      │
                      ├── exit_code≠0 ──→ CRASHED ──retry()──→ RUNNING
                      │                           ──kill()──→ DONE
                      │
                      └── done()
                           │
                           ├── merge conflict ──→ CONFLICTED
                           │
                           └── merge success
                                │
                                ├── LOW + auto ──→ ACCEPTED
                                │
                                └── HIGH / always ──→ REVIEW ──accept()──→ ACCEPTED
                                                                ──reject()──→ REJECTED
```

**Detection priority** (design invariant): terminal state → STALE (timeout) → in-process alive → PID alive → exit_code → spawn exit event → output heuristic → CRASHED.

Key invariants:
- `exit_code !== 0` must short-circuit to CRASHED (no fallthrough to heuristics)
- Terminal states are never re-detected
- Transition callbacks drive DAG dependency resolution

## DAG Scheduling Flow

```
prd.json → PlanParser.fromPrdJson() → PlanSpec
  → DAGValidator.validate() (4 rules: valid ID, no dup, no missing ref, no cycle via Kahn)
    → PlanExecutor.registerTasks() (all PENDING in state store)
      → Pre-create all worktrees (zero-delay launch)
        → Start root tasks (dependsOn=[], respect maxConcurrent)
          → onTaskDone() → check PENDING deps
            → dep REJECTED → cascade REJECT
            → dep DONE/ACCEPTED → dependency satisfied → launch
```

Cascading rejection: if any dependency is REJECTED, all dependents are also REJECTED (fixed-point iteration for multi-level propagation).

## done() Flow

```
Agent exits (exit_code=0)
  → transition callback fires done(name)
    │
    ├── 1. assessRisk() — must run BEFORE merge (otherwise diff is empty)
    ├── 2. Persist risk assessment
    ├── 3. _mergeAgent()
    │     - git add -A (agent may not commit)
    │     - git diff --cached --quiet (check for changes)
    │     - git commit (if changes exist)
    │     - git merge → conflict → auto-resolve → validate → rollback on failure → CONFLICTED
    ├── 4. Stop agent process
    ├── 5. Classification:
    │     - auto + LOW → ACCEPTED + cleanup worktree
    │     - auto + HIGH → REVIEW + create PR
    │     - always → REVIEW + create PR
    │     - never → ACCEPTED
    └── 6. Trigger DAG dependency resolution
```

Worktree cleanup rules: ACCEPTED/REJECTED → cleanup; CONFLICTED/REVIEW → preserve.

## Getting Started

### Prerequisites

- Node.js >= 18.0.0
- [Bun](https://bun.sh/) (package manager & runtime)
- [Claude CLI](https://docs.anthropic.com/en/docs/claude-code) (kscc)
- Git

### Install

```bash
git clone https://github.com/your-org/loomer.git
cd loomer
bun install
```

### Configure

Three-layer config override: CLI > Project `.loomer.json` > Global `~/.loomer/config.json` > built-in defaults.

Global config (`~/.loomer/config.json`):

```json
{
  "claudePath": "claude",
  "mergeStrategy": "auto",
  "maxConcurrent": 5,
  "defaultTimeoutMinutes": 30,
  "createPr": false,
  "autoMergeRules": {
    "maxFiles": 5,
    "maxLines": 200,
    "conflict": "review",
    "testFail": "auto"
  }
}
```

Project config (`.loomer.json` in repo root):

```json
{
  "mergeStrategy": "never",
  "maxConcurrent": 3
}
```

### Run a Plan

```bash
# From a prd.json file
loomer plan run --prd tasks/prd.json

# Check plan progress
loomer plan status
```

### CLI Commands

```bash
loomer start <name> --prompt <text>   # Start an agent
loomer done <name>                     # Risk-tiered merge
loomer kill <name> [--clean]           # Kill agent (--clean removes data)
loomer retry <name>                    # Retry from CRASHED/CONFLICTED
loomer accept <name>                   # Accept REVIEW agent
loomer reject <name>                   # Reject REVIEW agent
loomer log <name> [--lines 50]         # View agent output
loomer status [--all]                  # List agents (--all includes archived)
loomer serve [--port 3000]             # Start web dashboard
loomer plan run --prd <path>           # Execute PRD plan
loomer plan status                     # Plan progress
loomer daemon install                  # Install system service
loomer daemon start                    # Start daemon
```

### Web Dashboard

```bash
loomer serve
# Open http://localhost:3000
```

The dashboard provides:
- Agent list with status badges (9 color-coded states)
- Action buttons by state (Kill/Done/Accept/Reject/Retry)
- Log viewer (click agent → popup with recent output)
- Diff viewer (click → git diff --stat)
- DAG visualization during plan execution
- SSE auto-refresh (push-only-changes + 15s heartbeat)

### REST API

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/status?archived=false` | List agents |
| POST | `/api/start` | Create agent (`{name, prompt}`) |
| GET | `/api/log/:name?lines=50` | Agent output |
| GET | `/api/diff/:name?mode=stat` | Git diff |
| POST | `/api/done/:name` | Risk-tiered merge |
| POST | `/api/kill/:name?clean=0` | Kill agent |
| POST | `/api/retry/:name` | Retry agent |
| POST | `/api/accept/:name` | Accept agent |
| POST | `/api/reject/:name` | Reject agent |
| GET | `/api/events` | SSE real-time push |
| POST | `/api/plan/run` | Execute plan (`{path}` or `{prdPath}`) |
| GET | `/api/plan/status` | Plan progress |
| GET | `/api/plan/dag` | DAG structure |

## Tech Stack

- **Language:** TypeScript + ESM (Node.js 18+)
- **Runtime/PM:** Bun
- **Web:** Express + EJS
- **CLI:** Commander.js
- **Database:** SQLite (better-sqlite3, WAL mode)
- **Process:** child_process.spawn + stream-json pipe
- **Testing:** Vitest
- **Lint/Format:** Biome

## Key Differences from conductor-ui (Python)

| Module | Python | Loomer | Improvement |
|--------|--------|--------|-------------|
| Process mgmt | Popen + worker.log file | spawn + stream-json pipe | Real-time output, no file polling |
| State persistence | JSON + fcntl.flock | SQLite WAL | Cross-platform, atomic writes, no fcntl |
| Cross-process lock | fcntl.flock (Linux/Mac) | SQLite WAL + optimistic lock | Cross-platform |
| Web layer | Flask + Jinja2 | Express + EJS | Same ecosystem, similar template syntax |
| Config | Global config.json | Global + per-project `.loomer.json` | Multi-project support |
| Agent lifecycle | No archive | Archive (active/archived separation) | Clean agent list |
| PR creation | None | `gh pr create` auto | Auto PR on REVIEW |

## Design Documents

| Document | Content |
|----------|---------|
| [design-spec.md](doc/design-spec.md) | Design invariants (11 modules) + dogfooding lessons |
| [api-spec.md](doc/api-spec.md) | TypeScript API signatures (12 modules) |
| [state-machine.md](doc/state-machine.md) | 9 states + transition rules + detection priority |
| [risk-assessment.md](doc/risk-assessment.md) | 6 risk signals + merge strategies + done() flow |
| [dag-scheduling.md](doc/dag-scheduling.md) | prd.json format + DAG validation + dependency resolution |
| [technical-decisions.md](doc/technical-decisions.md) | 7 Python→Node decisions + 10 dogfooding lessons |
| [web-and-sse.md](doc/web-and-sse.md) | REST API + SSE + dashboard |

## License

MIT
