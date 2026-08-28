/** Shared types for FlowPeek runs, events, adapters, and config. */

export type RunStatus = "running" | "exited" | "unknown";
export type AgentOutputMode = "passthrough" | "compact";
export type PtyMode = "auto" | "always" | "never";
export type ProgressKind =
  | "determinate"
  | "activity"
  | "phase"
  | "counter"
  | "rate"
  | "heartbeat";

export type RunEventType =
  | "raw"
  | "phase"
  | "progress"
  | "activity"
  | "metric"
  | "warning"
  | "error"
  | "heartbeat"
  | "exit";

export interface RunRecord {
  id: string;
  sessionId: string;
  parentRunId?: string;
  rootRunId: string;
  agentName?: string;
  label?: string;
  command: string[];
  cwd: string;
  startedAt: string;
  endedAt?: string;
  status: RunStatus;
  exitCode?: number | null;
  signal?: string | null;
  adapterId?: string;
  adapterSource?: string;
  pty: boolean;
  agentOutput: AgentOutputMode;
  pid?: number;
  pgid?: number;
  droppedRawChunks: number;
  droppedRawBytes: number;
  telemetryConnected: boolean;
  telemetryDisconnectedAt?: string;
  processState: "running" | "exited" | "unknown";
}

export interface SessionSummary {
  id: string;
  agentName?: string;
  cwd?: string;
  startedAt: string;
  endedAt?: string;
  status: RunStatus;
  runCount: number;
  rootCount: number;
  runningCount: number;
}

export interface ProgressPayload {
  kind: ProgressKind;
  current?: number;
  total?: number;
  percent?: number;
  message?: string;
  unit?: string;
}

export interface RunEvent {
  runId: string;
  seq: number;
  ts: string;
  type: RunEventType;
  /** Base64 of raw terminal bytes. Present on type=raw. */
  b64?: string;
  /** Decoded length of the raw chunk. */
  byteLength?: number;
  phase?: string;
  progress?: ProgressPayload;
  activity?: string;
  metric?: { name: string; value: number; unit?: string };
  message?: string;
  exitCode?: number | null;
  signal?: string | null;
  dropped?: number;
}

export interface AdapterMatchRule {
  executables?: string[];
  executable?: string;
  subcommand?: string;
  subcommands?: string[];
  argsRegex?: string;
}

export interface AdapterPattern {
  regex: string;
  flags?: string;
  kind?:
    | "activity"
    | "phase"
    | "progress"
    | "metric"
    | "warning"
    | "error"
    | "complete"
    | "heartbeat";
  message?: string;
  phase?: string;
  name?: string;
  current?: string;
  total?: string;
  value?: string;
  unit?: string;
}

export interface AdapterSpec {
  id: string;
  name: string;
  version?: number | string;
  kind?: "yaml" | "script" | "builtin";
  match: AdapterMatchRule | AdapterMatchRule[];
  patterns?: AdapterPattern[];
  warnings?: AdapterPattern[];
  errors?: AdapterPattern[];
  complete?: AdapterPattern[];
  /** Script body (JS) when kind=script. */
  script?: string;
  versionProbe?: { args?: string[]; timeoutMs?: number };
}

export interface ResolvedAdapter {
  spec: AdapterSpec;
  source: "project" | "user" | "builtin" | "generic";
  path?: string;
}

export interface AppConfig {
  daemon: {
    /** Stop this many seconds after the last active run. 0 disables. */
    idle_seconds: number;
  };
  dashboard: {
    host: string;
    port: number;
    auto_start: boolean;
  };
  terminal: {
    mode: PtyMode;
  };
  agent_output: {
    mode: AgentOutputMode;
    heartbeat_seconds: number;
  };
  adapters: {
    allow_project: boolean;
    allow_user: boolean;
    allow_agent_generated: boolean;
    search_paths: string[];
  };
  storage: {
    max_run_mb: number;
  };
  learning: {
    save_fixtures: boolean;
    fixture_tail_lines: number;
  };
}

export interface RunOptions {
  command: string[];
  cwd: string;
  project?: string;
  sessionId?: string;
  agentName?: string;
  label?: string;
  adapter: "auto" | "none" | string;
  agentOutput: AgentOutputMode;
  pty: PtyMode;
  jsonMeta: boolean;
  noDashboardUrl: boolean;
  env?: NodeJS.ProcessEnv;
}

export type IpcMessage =
  | { t: "hello"; run: RunRecord }
  | { t: "raw"; id: string; s: number; d: string; n: number }
  | { t: "evt"; id: string; event: RunEvent }
  | { t: "exit"; id: string; code: number | null; signal: string | null; endedAt: string }
  | { t: "hb"; id: string; ts: string; dropped: number }
  | { t: "drop"; id: string; dropped: number }
  | { t: "adapter"; id: string; adapterId: string; source: string }
  | { t: "bye"; id: string };

export type IpcDownlink =
  | { t: "ack"; id: string }
  | { t: "evt"; id: string; event: RunEvent }
  | { t: "adapter-fail"; id: string; message: string };
