# Changelog

All notable changes to FlowPeek are documented in this file.

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
