import { loadConfig } from "../config.js";
import { newRunId, nowIso } from "../ids.js";
import { ensureHome, runUrl } from "../paths.js";
import type { RunOptions, RunRecord } from "../types.js";
import { CompactPrinter } from "./compact.js";
import { ensureDaemon } from "./ensure-daemon.js";
import { installSignalForwarders, unixExitCode } from "./signals.js";
import { spawnCommand } from "./spawn.js";
import { TelemetryClient } from "./telemetry.js";

export async function runWrapped(opts: RunOptions): Promise<number> {
  if (!opts.command.length) {
    process.stderr.write("flowpeek run: missing command. Use: flowpeek run -- <command>\n");
    return 2;
  }

  const cfg = loadConfig({
    project: opts.project,
    cwd: opts.cwd,
    cli: { pty: opts.pty, agentOutput: opts.agentOutput },
  });
  ensureHome();

  const runId = newRunId();
  const run: RunRecord = {
    id: runId,
    label: opts.label,
    command: opts.command,
    cwd: opts.cwd,
    startedAt: nowIso(),
    status: "running",
    processState: "running",
    adapterId: opts.adapter === "none" ? "none" : opts.adapter === "auto" ? undefined : opts.adapter,
    pty: opts.pty !== "never",
    agentOutput: opts.agentOutput,
    droppedRawChunks: 0,
    droppedRawBytes: 0,
    telemetryConnected: false,
  };

  // Fail-open: daemon issues never block spawning the real command.
  const daemonOk = await ensureDaemon(cfg).catch(() => false);
  const tel = new TelemetryClient();
  const compact = new CompactPrinter(
    opts.agentOutput,
    cfg.agent_output.heartbeat_seconds,
  );

  tel.onDownlink = (msg) => {
    if (msg.t === "evt") compact.onEvent(msg.event);
    if (msg.t === "adapter-fail") {
      compact.onEvent({
        runId,
        seq: 0,
        ts: nowIso(),
        type: "warning",
        message: `adapter disabled: ${msg.message}`,
      });
    }
  };

  if (!opts.noDashboardUrl) {
    const url = runUrl(runId, cfg.dashboard.host, cfg.dashboard.port);
    process.stderr.write(`[flowpeek] Live: ${url}\n`);
  }
  if (opts.jsonMeta) {
    process.stderr.write(
      JSON.stringify({
        runId,
        url: runUrl(runId, cfg.dashboard.host, cfg.dashboard.port),
        command: opts.command,
        cwd: opts.cwd,
        daemon: daemonOk,
      }) + "\n",
    );
  }

  let handle;
  try {
    handle = await spawnCommand({
      command: opts.command,
      cwd: opts.cwd,
      env: opts.env || process.env,
      mode: opts.pty,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[flowpeek] failed to spawn: ${msg}\n`);
    return 1;
  }

  run.pid = handle.pid;
  run.pgid = handle.pgid;
  run.pty = handle.pty;
  tel.attach(run);
  compact.start();

  const hb = setInterval(() => {
    tel.heartbeat();
    compact.maybeHeartbeat();
    run.droppedRawChunks = tel.queue.droppedChunks;
    run.telemetryConnected = tel.connected;
  }, 1000);
  hb.unref?.();

  const passthrough = opts.agentOutput === "passthrough";
  handle.onData((chunk) => {
    // Telemetry is strictly side-channel: enqueue, never await.
    try {
      tel.sendRaw(chunk);
    } catch {
      /* fail open */
    }
    try {
      compact.onRaw(chunk);
    } catch {
      /* fail open */
    }
    if (passthrough) {
      const ok = process.stdout.write(chunk);
      if (!ok) {
        handle.pause?.();
        process.stdout.once("drain", () => handle.resume?.());
      }
    }
  });

  const uninstall = installSignalForwarders(handle, {
    onWinch: () => {
      if (handle.resize && process.stdout.columns && process.stdout.rows) {
        handle.resize(process.stdout.columns, process.stdout.rows);
      }
    },
  });

  return await new Promise<number>((resolve) => {
    let settled = false;
    const finish = (code: number | null, signal: string | null) => {
      if (settled) return;
      settled = true;
      clearInterval(hb);
      uninstall();
      const exitCode = unixExitCode(code, signal);
      try {
        compact.complete(code, signal);
      } catch {
        /* ignore */
      }
      try {
        tel.exit(code, signal);
      } catch {
        /* ignore */
      }
      // Give the socket a brief chance to flush structured exit, never blocking long.
      // Keep this timer referenced so the event loop cannot drain with exit 0
      // before we resolve (stdin is often ignored when an agent/test spawns us).
      setTimeout(() => {
        tel.close();
        resolve(exitCode);
      }, 40);
    };
    handle.onExit(finish);
  });
}
