import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { daemonPidPath, daemonSockPath, dashboardUrl, ensureHome } from "../paths.js";
import type { AppConfig } from "../types.js";

function cliEntry(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const dist = join(here, "..", "cli.js");
  const src = join(here, "..", "cli.ts");
  if (existsSync(dist)) return dist;
  if (existsSync(src)) return src;
  return process.argv[1];
}

export function isDaemonHealthy(cfg: AppConfig, timeoutMs = 400): Promise<boolean> {
  const url = `${dashboardUrl(cfg.dashboard.host, cfg.dashboard.port)}/api/health`;
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Best-effort daemon start. Failure never throws — the wrapper still runs the command.
 */
export async function ensureDaemon(cfg: AppConfig): Promise<boolean> {
  if (!cfg.dashboard.auto_start) {
    return isDaemonHealthy(cfg);
  }
  if (await isDaemonHealthy(cfg)) return true;

  const home = ensureHome();
  const pidPath = daemonPidPath();
  if (existsSync(pidPath)) {
    const pid = Number(readFileSync(pidPath, "utf8").trim());
    if (pid && pidAlive(pid) && (await isDaemonHealthy(cfg))) return true;
  }

  try {
    const entry = cliEntry();
    const args = entry.endsWith(".ts")
      ? ["--import", "tsx", entry, "daemon"]
      : [entry, "daemon"];
    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        FLOWPEEK_HOME: home,
        FLOWPEEK_PORT: String(cfg.dashboard.port),
        FLOWPEEK_HOST: cfg.dashboard.host,
      },
      windowsHide: true,
    });
    child.unref();
  } catch {
    return false;
  }

  const start = Date.now();
  while (Date.now() - start < 2500) {
    if (await isDaemonHealthy(cfg)) return true;
    await new Promise((r) => setTimeout(r, 80));
  }
  return false;
}

export { daemonSockPath };
