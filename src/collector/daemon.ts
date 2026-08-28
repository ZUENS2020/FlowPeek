import { writeFileSync, unlinkSync, existsSync } from "node:fs";
import { loadConfig } from "../config.js";
import { ensureHome, daemonPidPath, daemonSockPath, dashboardUrl, isLoopback } from "../paths.js";
import { getDb, purgeInterruptedRunRows } from "../storage/db.js";
import { deleteRunLog } from "../storage/log-store.js";
import { RunRegistry } from "./registry.js";
import { startIpcServer } from "./ipc.js";
import { startHttpServer } from "./http.js";
import { IdleShutdownTracker } from "./idle.js";

export async function startDaemon(opts: { foreground?: boolean; project?: string }): Promise<void> {
  const cfg = loadConfig({ project: opts.project });
  if (!isLoopback(cfg.dashboard.host)) {
    process.stderr.write(
      `Refusing to bind ${cfg.dashboard.host}. Dashboard is loopback-only.\n`,
    );
    process.exit(2);
  }
  const home = ensureHome();
  getDb();
  for (const id of purgeInterruptedRunRows()) deleteRunLog(id);
  const project = opts.project || process.cwd();
  const registry = new RunRegistry(cfg);
  const startedAt = Date.now();
  const idleMs = Math.max(0, cfg.daemon.idle_seconds * 1000);
  const activity = new IdleShutdownTracker(idleMs);
  registry.on("update", () => activity.touch());

  let ipc;
  try {
    ipc = await startIpcServer(registry, project);
  } catch (err) {
    process.stderr.write(`ipc listen failed: ${err instanceof Error ? err.message : err}\n`);
    process.exit(1);
  }

  let http;
  try {
    http = await startHttpServer(cfg, registry, startedAt, project);
  } catch (err) {
    process.stderr.write(`http listen failed: ${err instanceof Error ? err.message : err}\n`);
    process.exit(1);
  }

  writeFileSync(daemonPidPath(), String(process.pid));
  const url = dashboardUrl(cfg.dashboard.host, cfg.dashboard.port);
  process.stderr.write(`[flowpeek] daemon ${url} home=${home} pid=${process.pid}\n`);

  const stale = setInterval(() => registry.checkStale(), 3000);
  stale.unref?.();
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(stale);
    clearInterval(idleCheck);
    try {
      ipc.close();
    } catch {
      /* ignore */
    }
    try {
      http.close();
    } catch {
      /* ignore */
    }
    try {
      if (existsSync(daemonPidPath())) unlinkSync(daemonPidPath());
    } catch {
      /* ignore */
    }
    try {
      if (process.platform !== "win32" && existsSync(daemonSockPath())) unlinkSync(daemonSockPath());
    } catch {
      /* ignore */
    }
    process.exit(0);
  };
  const idleCheck = setInterval(() => {
    if (!activity.shouldStop(registry.list().length > 0)) return;
    process.stderr.write(`[flowpeek] daemon idle for ${cfg.daemon.idle_seconds}s; stopping\n`);
    shutdown();
  }, Math.max(100, Math.min(1000, idleMs > 0 ? idleMs / 4 : 1000)));
  idleCheck.unref?.();
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  if (!opts.foreground) {
    // Detached spawn already unref'd; just keep the event loop via servers.
  }
}
