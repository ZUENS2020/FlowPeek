import type { ChildProcess } from "node:child_process";

export const FORWARDED_SIGNALS = [
  "SIGINT",
  "SIGTERM",
  "SIGHUP",
  "SIGQUIT",
  "SIGWINCH",
] as const;

export type ForwardSignal = (typeof FORWARDED_SIGNALS)[number];

export interface SpawnHandle {
  pid: number;
  pgid?: number;
  pty: boolean;
  write(data: string | Buffer): void;
  resize?(cols: number, rows: number): void;
  onData(cb: (chunk: string) => void): void;
  onExit(cb: (code: number | null, signal: string | null) => void): void;
  kill(signal?: NodeJS.Signals): void;
  pause?(): void;
  resume?(): void;
  child?: ChildProcess;
}

export function killProcessGroup(pid: number, signal: NodeJS.Signals): void {
  if (process.platform === "win32") {
    try {
      process.kill(pid, signal);
    } catch {
      /* already dead */
    }
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      /* already dead */
    }
  }
}

export function installSignalForwarders(
  handle: SpawnHandle,
  extra?: { onWinch?: () => void },
): () => void {
  const handlers = new Map<string, () => void>();
  for (const sig of FORWARDED_SIGNALS) {
    const handler = () => {
      if (sig === "SIGWINCH") {
        extra?.onWinch?.();
        if (handle.pty && handle.resize && process.stdout.columns && process.stdout.rows) {
          try {
            handle.resize(process.stdout.columns, process.stdout.rows);
          } catch {
            /* ignore */
          }
        }
        if (!handle.pty) {
          killProcessGroup(handle.pgid || handle.pid, "SIGWINCH");
        }
        return;
      }
      killProcessGroup(handle.pgid || handle.pid, sig);
    };
    handlers.set(sig, handler);
    try {
      process.on(sig, handler);
    } catch {
      /* signal not supported on this platform */
    }
  }
  return () => {
    for (const [sig, handler] of handlers) {
      try {
        process.off(sig, handler);
      } catch {
        /* ignore */
      }
    }
  };
}

export function unixExitCode(code: number | null, signal: string | null): number {
  if (typeof code === "number") return code;
  if (signal) {
    const map = (process as NodeJS.Process & { constants?: { signals?: Record<string, number> } })
      .constants?.signals;
    const n = map?.[signal];
    if (typeof n === "number") return 128 + n;
    return 1;
  }
  return 0;
}
