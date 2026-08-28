import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import type { AgentOutputMode, AppConfig, PtyMode } from "./types.js";
import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  projectConfigPath,
  projectRoot,
  userConfigPath,
} from "./paths.js";

export const DEFAULT_CONFIG: AppConfig = {
  dashboard: {
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
    auto_start: true,
  },
  terminal: {
    mode: "auto",
  },
  agent_output: {
    mode: "passthrough",
    heartbeat_seconds: 10,
  },
  adapters: {
    allow_project: true,
    allow_user: true,
    allow_agent_generated: true,
    search_paths: [],
  },
  storage: {
    max_run_mb: 256,
  },
  learning: {
    save_fixtures: false,
    fixture_tail_lines: 200,
  },
};

function deepMerge<T>(base: T, over: unknown): T {
  if (!over || typeof over !== "object") return base;
  const out = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over as Record<string, unknown>)) {
    if (v && typeof v === "object" && !Array.isArray(v) && typeof out[k] === "object") {
      out[k] = deepMerge(out[k], v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out as T;
}

function loadYamlFile(path: string): unknown {
  if (!existsSync(path)) return {};
  try {
    return parseYaml(readFileSync(path, "utf8")) ?? {};
  } catch {
    return {};
  }
}

export function loadConfig(opts?: {
  project?: string;
  cwd?: string;
  cli?: Partial<{
    host: string;
    port: number;
    pty: PtyMode;
    agentOutput: AgentOutputMode;
  }>;
}): AppConfig {
  const project = projectRoot(opts?.cwd, opts?.project);
  const user = loadYamlFile(userConfigPath());
  const proj = loadYamlFile(projectConfigPath(project));
  let cfg = deepMerge(DEFAULT_CONFIG, user);
  cfg = deepMerge(cfg, proj);

  if (process.env.FLOWPEEK_PORT) {
    const p = Number(process.env.FLOWPEEK_PORT);
    if (Number.isFinite(p) && p > 0) cfg.dashboard.port = p;
  }
  if (process.env.FLOWPEEK_HOST) {
    cfg.dashboard.host = process.env.FLOWPEEK_HOST;
  }

  if (opts?.cli?.host) cfg.dashboard.host = opts.cli.host;
  if (opts?.cli?.port) cfg.dashboard.port = opts.cli.port;
  if (opts?.cli?.pty) cfg.terminal.mode = opts.cli.pty;
  if (opts?.cli?.agentOutput) cfg.agent_output.mode = opts.cli.agentOutput;

  if (!cfg.dashboard.host) cfg.dashboard.host = DEFAULT_HOST;
  return cfg;
}
