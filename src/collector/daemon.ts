import { writeFileSync, unlinkSync, existsSync } from "node:fs";
import { loadConfig } from "../config.js";
import { ensureHome, daemonPidPath, dashboardUrl, isLoopback } from "../paths.js";
import { getDb } from "../storage/db.js";
import { sweepRetention } from "../storage/retention.js";
import { RunRegistry } from "./registry.js";
import { startIpcServer } from "./ipc.js";
import { startHttpServer } from "./http.js";

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
  const project = opts.project || process.cwd();
  const registry = new RunRegistry(cfg);
  const startedAt = Date.now();

  try {
    await startIpcServer(registry, project);
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
  const retain = setInterval(() => {
    try {
      sweepRetention(cfg, registry.liveIds());
    } catch {
      /* ignore */
    }
  }, 60_000);
  retain.unref?.();
  try {
    sweepRetention(cfg, registry.liveIds());
  } catch {
    /* ignore */
  }

  const shutdown = () => {
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
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  if (!opts.foreground) {
    // Detached spawn already unref'd; just keep the event loop via servers.
  }
}
