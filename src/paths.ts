import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 47831;

export function flowpeekHome(): string {
  return process.env.FLOWPEEK_HOME || join(homedir(), ".flowpeek");
}

export function ensureHome(): string {
  const home = flowpeekHome();
  mkdirSync(join(home, "runs"), { recursive: true });
  mkdirSync(join(home, "adapters"), { recursive: true });
  return home;
}

export function dbPath(): string {
  return join(flowpeekHome(), "flowpeek.db");
}

export function runsDir(): string {
  return join(flowpeekHome(), "runs");
}

export function runLogPath(runId: string): string {
  return join(runsDir(), `${runId}.ndjson`);
}

export function daemonSockPath(): string {
  if (process.env.FLOWPEEK_SOCK) return process.env.FLOWPEEK_SOCK;
  if (process.platform === "win32") {
    const id = (process.env.USERNAME || "user").replace(/[^\w.-]/g, "_");
    return `\\\\.\\pipe\\flowpeek-${id}`;
  }
  return join(flowpeekHome(), "daemon.sock");
}

export function daemonPidPath(): string {
  return join(flowpeekHome(), "daemon.pid");
}

export function userAdapterDir(): string {
  return join(flowpeekHome(), "adapters");
}

export function projectRoot(cwd = process.cwd(), explicit?: string): string {
  return explicit || process.env.FLOWPEEK_PROJECT || cwd;
}

export function projectAdapterDir(project: string): string {
  return join(project, ".flowpeek", "adapters");
}

export function projectConfigPath(project: string): string {
  return join(project, ".flowpeek", "config.yaml");
}

export function userConfigPath(): string {
  return join(flowpeekHome(), "config.yaml");
}

export function dashboardUrl(host = DEFAULT_HOST, port = DEFAULT_PORT): string {
  return `http://${host}:${port}`;
}

export function runUrl(runId: string, host = DEFAULT_HOST, port = DEFAULT_PORT): string {
  return `${dashboardUrl(host, port)}/r/${runId}`;
}

export function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}
