# FlowPeek

FlowPeek is a transparent, AI-programmable observability layer inserted between a coding agent (Cursor / Codex / Claude Code / OpenCode) and a long-running CLI process. The coding agent keeps full control of the process lifecycle. FlowPeek only captures raw terminal telemetry and turns it into human-visible structured progress on a **local** dashboard.

> FlowPeek is an observability shell, not a task runner. It does not schedule, restart, stop, or attach to already-running PIDs.

The original design spec used the working name **AgentView**. The public product is FlowPeek (`flowpeek`). A hidden `agent-view` binary alias still invokes the same CLI.

## Install

```bash
npm install -g .
# or from the repo
npm install
npm run build
npx flowpeek --help
```

Requires Node.js 22.5+ (uses `node:sqlite`).

## Core command

```bash
flowpeek run -- npm run build
```

On start, the wrapper prints once:

```
[flowpeek] Live: http://127.0.0.1:47831/r/<run-id>
```

Open that URL on the same machine. The dashboard binds **127.0.0.1 only**.

### Run flags

| Flag | Meaning |
| --- | --- |
| `--label <text>` | Name shown in the dashboard |
| `--adapter auto\|none\|<id>` | Adapter selection (default `auto`) |
| `--agent-output passthrough\|compact` | Default `passthrough`: original output goes to the caller |
| `--pty auto\|always\|never` | Default `auto` (prefer PTY). `--no-pty` = `never` |
| `--project <path>` | Project root for `.flowpeek/` config and adapters |
| `--json-meta` | One JSON metadata line on stderr |
| `--no-dashboard-url` | Skip the Live URL line |

### Compact mode

```bash
flowpeek run --agent-output compact -- cargo build
```

The dashboard still receives the full raw log. The agent only sees coarse `[phase]`, `[progress]`, `[warning]`, `[error]`, `[heartbeat]`, and `[completed]` lines.

## Other commands

```bash
flowpeek daemon [--foreground]
flowpeek adapter list
flowpeek adapter resolve -- cargo build
flowpeek adapter inspect cargo-build
flowpeek adapter validate .flowpeek/adapters/my.yaml
flowpeek adapter test cargo-build --fixture fixtures/cargo.txt --json
flowpeek adapter scaffold my-tool --kind yaml
flowpeek adapter scaffold my-tool --kind script
```

The wrapper starts the daemon automatically if it is not running. Daemon failure never blocks the real command (fail open).

## Architecture

```
coding agent
    │  spawn + signals + wait
    ▼
flowpeek wrapper            ← exit code == child exit code
    │  PTY / pipes (primary path, never waits on telemetry)
    ▼
real command (+ grandchildren in the same process group)
    │
    └── async side channel (Unix socket / named pipe)
            ▼
        local collector  → SQLite metadata + append-only NDJSON
            ▼
        dashboard http://127.0.0.1:47831   (SSE live events)
```

Telemetry is best-effort. Collector crash, adapter crash, dashboard crash, or a full 4 MB queue **must not** stall, kill, or change the child. Raw chunks are dropped under backpressure; structured events and a drop counter are kept. The UI shows when telemetry was dropped or disconnected. Disconnected telemetry is **not** reported as process failure.

## Adapters

Search order:

1. `<project>/.flowpeek/adapters`
2. `~/.flowpeek/adapters`
3. built-in (`npm-install`, `cargo-build`, `pytest`, `ffmpeg`, `docker-build`)
4. `generic` fallback (elapsed, last activity, output rate, warning/error heuristics, heartbeat)

Never write generated adapters into the npm install directory.

Declarative YAML is preferred. Script adapters run in an isolated QuickJS runtime with a tiny `api` (`phase`, `progress`, `activity`, `metric`, `warning`, `error`, `event`, `complete`, `heartbeat`). No Node builtins, no fs, no network, no `child_process`. CPU ~20 ms/event, memory ~32 MB. On failure the adapter is disabled for that run and the raw log continues.

Adapters are parsers, not controllers. They never spawn the real task and never invent a percentage when the tool has no total.

## Storage and privacy

All data stays under `~/.flowpeek/` (override with `FLOWPEEK_HOME`):

- `flowpeek.db` — run metadata
- `runs/<run-id>.ndjson` — raw + structured events
- `adapters/` — user adapters
- `daemon.sock` / `daemon.pid`

Defaults: retain 7 days, 2048 MB total, 256 MB per run. Hitting `max_run_mb` stops saving **raw history** for that run but live stream + structured events continue. Storage limits never kill a real task.

Nothing is uploaded. Command, cwd, logs, adapters, and metrics never leave the machine.

## Config merge

CLI flags > `<project>/.flowpeek/config.yaml` > `~/.flowpeek/config.yaml` > defaults.

See `examples/config.yaml`.

## Safety boundaries (non-goals)

FlowPeek does **not**:

- schedule, queue, or restart tasks
- expose Dashboard Stop / Restart / kill, or `POST /run-command`
- attach to an already-running PID
- bind `0.0.0.0` by default (loopback only)
- depend on Cursor / Codex private APIs
- replace the agent's own background/wait/notification system

If a change starts deciding whether a background task should continue, it is the wrong architecture.

## Skill

Coding agents should read [`skill/SKILL.md`](skill/SKILL.md) for when and how to wrap commands.

## Tests

```bash
npm test
```

Transparency tests cover wrapper exit codes, SIGTERM process-group forwarding, collector death isolation, adapter throw isolation, PTY `\r` chunks, and high-volume backpressure.
