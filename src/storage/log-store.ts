import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import type { RunEvent } from "../types.js";
import { runLogPath } from "../paths.js";

export interface LogWriter {
  append(event: RunEvent): boolean;
  rawStopped: boolean;
  bytesWritten: number;
}

export function createLogWriter(runId: string, maxRunBytes: number): LogWriter {
  const path = runLogPath(runId);
  mkdirSync(dirname(path), { recursive: true });
  let bytesWritten = existsSync(path) ? statSync(path).size : 0;
  let rawStopped = bytesWritten >= maxRunBytes;
  return {
    get rawStopped() {
      return rawStopped;
    },
    get bytesWritten() {
      return bytesWritten;
    },
    append(event: RunEvent): boolean {
      if (event.type === "raw" && (rawStopped || bytesWritten >= maxRunBytes)) {
        rawStopped = true;
        return false;
      }
      try {
        const line = JSON.stringify(event) + "\n";
        const n = Buffer.byteLength(line);
        if (event.type === "raw" && bytesWritten + n > maxRunBytes) {
          rawStopped = true;
          return false;
        }
        appendFileSync(path, line);
        bytesWritten += n;
        return true;
      } catch {
        return false;
      }
    },
  };
}

export function readLogEvents(runId: string, afterSeq = 0, limit = 5000): RunEvent[] {
  const path = runLogPath(runId);
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  const out: RunEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line) as RunEvent;
      if (ev.seq > afterSeq) out.push(ev);
      if (out.length >= limit) break;
    } catch {
      /* skip */
    }
  }
  return out;
}

export function deleteRunLog(runId: string): void {
  const path = runLogPath(runId);
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {
    /* ignore */
  }
}

export function runLogSize(runId: string): number {
  const path = runLogPath(runId);
  try {
    return existsSync(path) ? statSync(path).size : 0;
  } catch {
    return 0;
  }
}
