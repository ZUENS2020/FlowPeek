import { appendFileSync, existsSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import type { RunEvent } from "../types.js";
import { runLogPath } from "../paths.js";

export interface LogWriter {
  append(event: RunEvent): boolean;
  dispose(): void;
  rawStopped: boolean;
  bytesWritten: number;
}

export function createLogWriter(runId: string, maxRunBytes: number): LogWriter {
  const path = runLogPath(runId);
  mkdirSync(dirname(path), { recursive: true });
  let bytesWritten = existsSync(path) ? statSync(path).size : 0;
  let rawStopped = bytesWritten >= maxRunBytes;
  let disposed = false;
  return {
    get rawStopped() {
      return rawStopped;
    },
    get bytesWritten() {
      return bytesWritten;
    },
    append(event: RunEvent): boolean {
      if (disposed) return false;
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
    dispose(): void {
      disposed = true;
    },
  };
}

export function deleteRunLog(runId: string): void {
  const path = runLogPath(runId);
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {
    /* ignore */
  }
}
