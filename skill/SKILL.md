---
name: flowpeek
description: Wrap long-running CLI commands in FlowPeek so humans can watch raw terminal output and structured progress on a local dashboard without taking control away from the coding agent.
---

# FlowPeek skill

FlowPeek is a transparent observability shell. You (the coding agent) still spawn, signal, wait on, and own the process. FlowPeek only captures telemetry and shows it at `http://127.0.0.1:47831`.

## When to wrap

Wrap a command with `flowpeek run -- …` when it is likely to run more than a few seconds: installs, compiles, test suites, docker/ffmpeg/cargo builds, large codegen, dataset jobs.

Do **not** wrap short queries (`ls`, `git status`, one-shot `cat`, trivial `node -e` probes).

## How to wrap

```bash
flowpeek run --label "frontend build" -- npm run build
```

Useful flags:

- `--agent-output compact` when output is huge (install logs, `cargo build -v`, ffmpeg). Dashboard still has the full raw log; you only see phase/progress/warning/error/heartbeat/completion.
- `--adapter auto` (default). Resolve first if you care: `flowpeek adapter resolve -- cargo build`.
- `--pty auto` (default). Use `--no-pty` only if the tool misbehaves under a PTY.
- `--json-meta` when you need the run id as JSON on stderr.
- `--project <path>` when the project root is not `cwd`.
- `--session <id>` or `FLOWPEEK_SESSION_ID` to correlate concurrently active commands from one coding task.
- `--agent <name>` or `FLOWPEEK_AGENT_NAME` to label that session.

At the start of a coding task with several long commands, create one correlation id:

```bash
export FLOWPEEK_SESSION_ID=$(flowpeek session-id)
export FLOWPEEK_AGENT_NAME=Codex
```

This is metadata only. It does not create or manage a task.

On start, stderr prints:

```
[flowpeek] Live: http://127.0.0.1:47831/r/<run-id>
```

Tell the human that URL once. Do not poll the dashboard. Do not wait on HTTP. Your wait is the wrapper process, exactly as you would wait on the naked command.

The wrapper exit code **is** the real command exit code. Forward that to the user.

## Output hygiene

Do not hide progress just to keep your own context small:

- Bad: `npm run build 2>&1 | tail -n 20` or piping to `/dev/null` only to reduce logs.
- Good: `flowpeek run --agent-output compact -- npm run build`

`rg` / `find` / `grep` are still correct when search **is** the task.

## Adapters

Adapters parse logs. They never start, stop, or replace the command.

Search order: `<project>/.flowpeek/adapters` → `~/.flowpeek/adapters` → built-in → generic.

Before a long run:

```bash
flowpeek adapter resolve -- <command>
```

- If a specific adapter matches, use it (`--adapter <id>` or just `auto`).
- If none match, **generic is usually enough**. It shows status, elapsed, last activity, output rate, warning/error heuristics, heartbeat. Do not invent a percentage.
- Only write a project/user adapter when the format is stable, the command is safe to sample, and you will reuse it. Never probe a command with unacceptable side effects: probe really runs and then stops the command.
- For a reusable unknown command, use the complete learning loop:

```bash
flowpeek probe --max-seconds 15 --max-bytes 2mb --max-lines 10000 -- my-tool build
flowpeek adapter scaffold my-tool --kind yaml
flowpeek adapter validate .flowpeek/adapters/my-tool.yaml
flowpeek adapter test my-tool --fixture .flowpeek/fixtures/my-tool-<timestamp>.log --report --json
```

Read the saved fixture before writing the adapter. Proceed to the formal `flowpeek run` only after report mode returns `PASS`. If the command is one-off, keep generic instead of spending time on an adapter.

Put adapters in the **project or user** directory. Never write them into the npm package install path.

If adapter validation fails, run with `--adapter none` or generic. Never stop the real task because an adapter mismatches.

## What you must not do

- Do not wrap every short command.
- Do not spend a long time writing adapters for unknown tools.
- Do not probe commands that are destructive, costly, externally visible, or unsafe to repeat.
- Do not fabricate totals or determinate percentages.
- Do not treat “has output” as “has progress”.
- Do not poll `http://127.0.0.1:47831`.
- Do not kill/restart via FlowPeek — there are no such controls. Signal the wrapper as you would the child.
- Do not replace Cursor/Codex/Claude Code background, wait, or notification systems. You still own the process.
- Do not upload logs, cwd, adapters, or metrics anywhere. FlowPeek is local-only.

## Failure model (trust this)

Collector, adapter, or dashboard death must not stop, pause, or stall the child. You still receive passthrough stdout (or compact summaries). If you see `telemetry connection lost` on the dashboard, that is **not** process failure.

## Compact summaries you will see

```
[flowpeek] [phase] started
[flowpeek] [activity] Compiling serde
[flowpeek] [warning] unused variable: x
[flowpeek] [error] cannot find type Foo
[flowpeek] [heartbeat] running 45s, 120.0 KB, last activity 2s ago
[flowpeek] [completed] exit 0 in 62.0s, 120.0 KB captured
```
