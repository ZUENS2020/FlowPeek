# Changelog

All notable changes to FlowPeek are documented in this file.

## Unreleased

### Added

- Read-only `flowpeek tui` monitoring for active sessions, run trees, structured progress, and sanitized live output, with mouse-first navigation, keyboard fallback, and direct `--session` / `--run` entry points.
- `flowpeek tui --once` for plain-text snapshots in scripts and non-interactive terminals.
- The local collector now exits automatically 60 seconds after the last active run, even if an idle viewer remains open, and restarts on demand.

### Fixed

- CLI `--version` now matches the 0.2.1 package release.

## 0.2.1 — 2026-08-28

### Changed

- FlowPeek's agent skill is now selected automatically for long-running and duration-uncertain CLI work, including installs, builds, tests, packaging, Docker, Cargo, ffmpeg, code generation, migrations, and data jobs.
- The skill now explicitly excludes short read-only queries, interactive shells, commands already wrapped by FlowPeek, and commands where the user opts out.

## 0.2.0 — 2026-08-28

### Added

- Native execution context with session, root-run, parent-run, and agent metadata.
- Live session tree for concurrent and nested commands.
- `flowpeek session-id`, `--session`, and `--agent` CLI support.
- `flowpeek probe` for bounded, faithful terminal fixture capture.
- Strict adapter fixture reports with stable JSON output.

### Changed

- Dashboard now shows active sessions only and refreshes the Live list automatically.
- Completed runs are removed from the Dashboard, SQLite metadata, and NDJSON log storage.
- PTY spawning, stdin forwarding, signal propagation, compact output, and backpressure handling were hardened.
- npm packaging now includes the PTY helper permission repair script.

### Removed

- Recent/historical session storage and the Dashboard Recent lane.
- Retention settings that only applied to historical run storage.

### Release status

- Source release is available from the GitHub repository.
- npm registry publication is deferred pending npm account verification.

## 0.1.0

- Initial transparent wrapper, local collector, adapters, compact output, and local Dashboard.
