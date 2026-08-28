# FlowPeek

FlowPeek is a transparent, AI-programmable observability layer inserted between a coding agent (Cursor / Codex / Claude Code / OpenCode) and a long-running CLI process. The coding agent keeps full control of the process lifecycle. FlowPeek only captures raw terminal telemetry and turns it into human-visible structured progress through a **local** Web dashboard or terminal UI.

> FlowPeek is an observability shell, not a task runner. It does not schedule, restart, stop, or attach to already-running PIDs.

The original design spec used the working name **AgentView**. The public product is FlowPeek (`flowpeek`). A hidden `agent-view` binary alias still invokes the same CLI.

## Install

The npm registry publication is currently deferred. Install the current source release directly from GitHub:

```bash
npm install -g github:ZUENS2020/FlowPeek
```

For development:

```bash
git clone https://github.com/ZUENS2020/FlowPeek.git
cd FlowPeek
npm install
npm run build
npm link
flowpeek --help
```

Requires Node.js 22.5+ (uses `node:sqlite`).

Current source release: **0.2.1**. See [CHANGELOG.md](CHANGELOG.md) for release notes.

## Core command

```bash
flowpeek run -- npm run build
```

On start, the wrapper prints once:

```
[flowpeek] Live: http://127.0.0.1:47831/r/<run-id>
```

Open that URL on the same machine, or monitor all active work in the terminal with `flowpeek tui`. The collector binds **127.0.0.1 only**.

### Run flags

| Flag | Meaning |
| --- | --- |
| `--label <text>` | Name shown in the dashboard |
| `--adapter auto\|none\|<id>` | Adapter selection (default `auto`) |
| `--agent-output passthrough\|compact` | Default `passthrough`: original output goes to the caller |
| `--pty auto\|always\|never` | Default `auto` (prefer PTY). `--no-pty` = `never` |
| `--project <path>` | Project root for `.flowpeek/` config and adapters |
| `--session <id>` | Correlate concurrently active runs in one session |
| `--agent <name>` | Optional agent name shown for the session |
| `--json-meta` | One JSON metadata line on stderr |
| `--no-dashboard-url` | Skip the Live URL line |

### Compact mode

```bash
flowpeek run --agent-output compact -- cargo build
```

The dashboard still receives the full raw log. The agent only sees coarse `[phase]`, `[progress]`, `[warning]`, `[error]`, `[heartbeat]`, and `[completed]` lines.

## Terminal UI

Use the read-only TUI when opening a browser is inconvenient:

```bash
flowpeek tui
flowpeek tui --session <session-id>
flowpeek tui --run <run-id>
```

The default view lists active sessions. Use the mouse to click a session, click a run to switch its log, use the wheel to move through the current list, and click the bottom `Back`, `Refresh`, or `Quit` actions. Keyboard controls (`↑`/`↓`, `j`/`k`, `Enter`, `Esc`, `r`, `q`) remain available as a fallback. The selected run shows its tree position, phase, adapter, determinate progress when available, and a sanitized live-output tail.

`flowpeek tui --once` prints one plain-text snapshot and exits, so the same view also works in scripts and non-interactive terminals. Like the Web dashboard, the TUI only exposes active work, stores no completed history, and has no task-control actions.

## Other commands

```bash
flowpeek daemon [--foreground]
flowpeek adapter list
flowpeek adapter resolve -- cargo build
flowpeek adapter inspect cargo-build
flowpeek adapter validate .flowpeek/adapters/my.yaml
flowpeek adapter test cargo-build --fixture fixtures/cargo.txt --json
flowpeek adapter test cargo-build --fixture fixtures/cargo.txt --report --json
flowpeek adapter scaffold my-tool --kind yaml
flowpeek adapter scaffold my-tool --kind script
```

The wrapper starts the collector automatically if it is not running. Collector failure never blocks the real command (fail open). Sixty seconds after the last active run ends, the collector exits automatically; an open but idle Web/TUI view does not keep it alive. The next run or newly opened viewer starts it again.

## Sessions and nested runs

Every top-level run gets a lightweight session id. Reuse one id to correlate commands that overlap or nest without giving FlowPeek lifecycle control:

```bash
export FLOWPEEK_SESSION_ID=$(flowpeek session-id)
export FLOWPEEK_AGENT_NAME=Codex
flowpeek run -- npm install
flowpeek run -- npm run build
flowpeek run -- npm test
```

If a wrapped command launches another `flowpeek run`, the child automatically inherits the session and records the current run as its parent. While commands are active, the dashboard groups concurrent roots and nested children at `/s/<session-id>`.

This is metadata only. A FlowPeek session cannot start, stop, wait on, or restart commands. Finished runs disappear from the Dashboard and are removed from FlowPeek's metadata and log storage.

## Probe and adapter learning

`probe` samples a real, safe-to-repeat command without adding it to Dashboard or the live run store:

```bash
flowpeek probe --max-seconds 15 --max-bytes 2mb --max-lines 10000 -- my-tool build
```

The raw fixture is saved under `.flowpeek/fixtures/`. Probe stops the sampled process group at the first configured limit and returns success when the fixture was saved. It is not a sandbox or dry-run: do not probe commands with unacceptable side effects.

After writing an adapter, run a strict fixture report:

```bash
flowpeek adapter test my-tool \
  --fixture .flowpeek/fixtures/my-tool-<timestamp>.log \
  --report
```

Report mode counts only events produced by the target adapter while processing the fixture. Generic fallback and lifecycle-only events cannot make a non-matching adapter pass.

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
        local collector  → transient metadata + live NDJSON
            ├── Web dashboard http://127.0.0.1:47831
            └── flowpeek tui                         (live events)
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

## Live storage and privacy

While a command is running, transient data stays under `~/.flowpeek/` (override with `FLOWPEEK_HOME`):

- `flowpeek.db` — active run metadata; the row is removed on exit
- `runs/<run-id>.ndjson` — live raw + structured events; the file is removed on exit
- `adapters/` — user adapters
- `daemon.sock` / `daemon.pid`

The Web dashboard and TUI have no Recent view and do not expose completed sessions. `max_run_mb` defaults to 256 MB; hitting it stops spooling additional raw chunks for the active run, while the live stream and structured events continue. Storage limits never kill a real task.

An upgrade does not automatically delete records produced by an older FlowPeek version. They are no longer exposed by the API or Dashboard.

Nothing is uploaded. Command, cwd, logs, adapters, and metrics never leave the machine.

## Config merge

CLI flags > `<project>/.flowpeek/config.yaml` > `~/.flowpeek/config.yaml` > defaults.

The collector idle timeout defaults to 60 seconds:

```yaml
daemon:
  idle_seconds: 60 # 0 keeps an explicitly started collector alive
```

`FLOWPEEK_IDLE_SECONDS` can override it for one process.

See `examples/config.yaml`.

## Safety boundaries (non-goals)

FlowPeek does **not**:

- schedule, queue, or restart tasks
- expose Web/TUI Stop / Restart / kill, or `POST /run-command`
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

## License

FlowPeek is released under the [MIT License](LICENSE). Copyright © 2026 ZUENS2020.
