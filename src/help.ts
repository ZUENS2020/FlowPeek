export const VERSION = "0.2.0";

export const HELP = `FlowPeek — transparent observability for long-running agent CLI tasks.

USAGE
  flowpeek run [options] -- <command> [args...]
  flowpeek probe [options] -- <command> [args...]
  flowpeek session-id
  flowpeek daemon [--foreground]
  flowpeek adapter list
  flowpeek adapter resolve -- <command> [args...]
  flowpeek adapter inspect <id>
  flowpeek adapter validate [path]
  flowpeek adapter test <id|path> [--fixture <file>] [--report] [--json]
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
  --session <id>                  Correlate concurrently active runs
  --agent <name>                  Optional agent label for the session
  --json-meta                     Print one JSON metadata line to stderr
  --no-dashboard-url              Do not print the Live: URL

PROBE OPTIONS
  --max-seconds <n>               Default: 15
  --max-bytes <n|kb|mb|gb>        Default: 2mb
  --max-lines <n>                 Default: 10000
  --pty auto|always|never         Default: auto
  --project <path>                Fixture project root
  --json                          Print a machine-readable capture report

flowpeek run never starts, stops, or owns a background task. The caller
retains lifecycle control. Telemetry is fail-open: collector/adapter/
dashboard failure cannot stall or kill the real command. probe is an
explicit diagnostic command that runs and stops only its sampled child.

Dashboard (loopback only): http://127.0.0.1:47831
`;
