import { createWriteStream, existsSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { projectFixtureDir } from "./paths.js";
import type { PtyMode } from "./types.js";
import { forwardStdinToPty } from "./wrapper/io.js";
import { installSignalForwarders } from "./wrapper/signals.js";
import { spawnCommand } from "./wrapper/spawn.js";

type ProbeStopReason = "exited" | "time_limit" | "byte_limit" | "line_limit";

export interface ProbeOptions {
  command: string[];
  project: string;
  cwd: string;
  pty: PtyMode;
  json: boolean;
  maxSeconds?: string;
  maxBytes?: string;
  maxLines?: string;
  env?: NodeJS.ProcessEnv;
}

export interface ProbeReport {
  fixture: string;
  command: string[];
  bytes: number;
  lines: number;
  durationMs: number;
  stopReason: ProbeStopReason;
  childExitCode: number | null;
  signal: string | null;
}

function positiveNumber(raw: string | undefined, fallback: number, name: string): number {
  if (raw == null) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return value;
}

export function parseByteLimit(raw = "2mb"): number {
  const match = raw.trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/);
  if (!match) throw new Error("--max-bytes must be a positive number with optional b/kb/mb/gb suffix");
  const scales: Record<string, number> = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 };
  const scale = scales[match[2] || "b"] || 1;
  const bytes = Math.floor(Number(match[1]) * scale);
  if (!Number.isFinite(bytes) || bytes <= 0) throw new Error("--max-bytes must be greater than zero");
  return bytes;
}

function fixturePath(project: string, command: string[]): string {
  const exe = basename(command[0] || "command")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "command";
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return join(projectFixtureDir(project), `${exe}-${stamp}.log`);
}

function writeReport(report: ProbeReport, json: boolean): void {
  if (json) {
    process.stdout.write(JSON.stringify(report) + "\n");
    return;
  }
  process.stdout.write(`[flowpeek] Probe captured ${report.bytes} bytes / ${report.lines} lines / ${(report.durationMs / 1000).toFixed(1)}s\n`);
  process.stdout.write(`[flowpeek] Stop: ${report.stopReason}${report.childExitCode != null ? ` · exit ${report.childExitCode}` : ""}${report.signal ? ` · ${report.signal}` : ""}\n`);
  process.stdout.write(`[flowpeek] Fixture: ${report.fixture}\n`);
}

export async function runProbe(opts: ProbeOptions): Promise<number> {
  if (!opts.command.length) {
    process.stderr.write("flowpeek probe: missing command. Use: flowpeek probe -- <command>\n");
    return 2;
  }

  let maxSeconds: number;
  let maxBytes: number;
  let maxLines: number;
  try {
    maxSeconds = positiveNumber(opts.maxSeconds, 15, "--max-seconds");
    maxBytes = parseByteLimit(opts.maxBytes || "2mb");
    maxLines = Math.floor(positiveNumber(opts.maxLines, 10_000, "--max-lines"));
    if (maxLines < 1) throw new Error("--max-lines must be at least 1");
  } catch (err) {
    process.stderr.write(`[flowpeek] ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }

  const project = resolve(opts.project);
  const finalPath = fixturePath(project, opts.command);
  const partialPath = `${finalPath}.partial-${process.pid}`;
  try {
    mkdirSync(projectFixtureDir(project), { recursive: true });
  } catch (err) {
    process.stderr.write(`[flowpeek] cannot create fixture directory: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  let handle;
  try {
    handle = await spawnCommand({
      command: opts.command,
      cwd: resolve(opts.cwd),
      env: opts.env || process.env,
      mode: opts.pty,
    });
  } catch (err) {
    process.stderr.write(`[flowpeek] probe failed to spawn: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  const output = createWriteStream(partialPath, { flags: "wx" });
  const started = Date.now();
  let bytes = 0;
  let breaks = 0;
  let endsWithBreak = false;
  let previousWasCr = false;
  let stopReason: ProbeStopReason = "exited";
  let stopping = false;
  let settled = false;
  let writeError: Error | null = null;
  const timers = new Set<NodeJS.Timeout>();

  const lineCount = () => breaks + (bytes > 0 && !endsWithBreak ? 1 : 0);
  const schedule = (fn: () => void, ms: number) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      fn();
    }, ms);
    timers.add(timer);
  };
  const beginStop = (reason: ProbeStopReason) => {
    if (stopping || settled) return;
    stopping = true;
    stopReason = reason;
    handle.kill("SIGINT");
    schedule(() => {
      if (settled) return;
      handle.kill("SIGTERM");
      schedule(() => {
        if (settled) return;
        handle.kill("SIGKILL");
      }, 2000);
    }, 2000);
  };

  output.on("error", (err) => {
    writeError = err;
    beginStop("exited");
  });
  handle.onData((chunk) => {
    if (settled || writeError) return;
    const buffer = Buffer.from(chunk, "utf8");
    bytes += buffer.length;
    for (const char of chunk) {
      if (char === "\r") {
        breaks += 1;
        previousWasCr = true;
      } else if (char === "\n") {
        if (!previousWasCr) breaks += 1;
        previousWasCr = false;
      } else {
        previousWasCr = false;
      }
    }
    endsWithBreak = /[\r\n]$/.test(chunk);
    const ok = output.write(buffer);
    if (!ok) {
      handle.pause?.();
      output.once("drain", () => handle.resume?.());
    }
    if (bytes >= maxBytes) beginStop("byte_limit");
    else if (lineCount() >= maxLines) beginStop("line_limit");
  });

  const uninstallStdin = forwardStdinToPty(handle);
  const uninstallSignals = installSignalForwarders(handle, {
    onWinch: () => {
      if (handle.resize && process.stdout.columns && process.stdout.rows) {
        handle.resize(process.stdout.columns, process.stdout.rows);
      }
    },
  });
  const timeTimer = setTimeout(() => beginStop("time_limit"), maxSeconds * 1000);
  timers.add(timeTimer);

  return await new Promise<number>((resolveCode) => {
    handle.onExit((childExitCode, signal) => {
      if (settled) return;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      uninstallSignals();
      uninstallStdin();
      output.end(() => {
        if (writeError) {
          try {
            if (existsSync(partialPath)) unlinkSync(partialPath);
          } catch {
            /* only remove the incomplete fixture we created */
          }
          process.stderr.write(`[flowpeek] fixture write failed: ${writeError.message}\n`);
          resolveCode(1);
          return;
        }
        try {
          renameSync(partialPath, finalPath);
        } catch (err) {
          try {
            if (existsSync(partialPath)) unlinkSync(partialPath);
          } catch {
            /* only remove the incomplete fixture we created */
          }
          process.stderr.write(`[flowpeek] fixture finalize failed: ${err instanceof Error ? err.message : String(err)}\n`);
          resolveCode(1);
          return;
        }
        writeReport(
          {
            fixture: finalPath,
            command: opts.command,
            bytes,
            lines: lineCount(),
            durationMs: Date.now() - started,
            stopReason,
            childExitCode,
            signal,
          },
          opts.json,
        );
        resolveCode(0);
      });
    });
  });
}
