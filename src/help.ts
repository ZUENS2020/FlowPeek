export const VERSION = "0.1.0";

export const HELP = `FlowPeek — transparent observability for long-running agent CLI tasks.

USAGE
  flowpeek run [options] -- <command> [args...]
  flowpeek daemon [--foreground]
  flowpeek adapter list
  flowpeek adapter resolve -- <command> [args...]
  flowpeek adapter inspect <id>
  flowpeek adapter validate [path]
  flowpeek adapter test <id|path> [--fixture <file>] [--json]
  flowpeek adapter scaffold <id> [--kind yaml|script] [--project <path>]
  flowpeek --help
  flowpeek --version

RUN OPTIONS
  --label <text>                  Label shown on the dashboard
  --adapter auto|none|<id>        Adapter selection (default: auto)
  --agent-output passthrough|compact
  --pty auto|always|never         Default: auto (prefer PTY)
  --no-pty                        Alias for --pty never
  --project <path>                Project root for config/adapters
  --json-meta                     Print one JSON metadata line to stderr
  --no-dashboard-url              Do not print the Live: URL

FlowPeek never starts, stops, or owns the wrapped process. The caller
retains lifecycle control. Telemetry is fail-open: collector/adapter/
dashboard failure cannot stall or kill the real command.

Dashboard (loopback only): http://127.0.0.1:47831
`;
