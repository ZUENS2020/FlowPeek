import { spawn, type ChildProcess } from "node:child_process";
import type { PtyMode } from "../types.js";
import type { SpawnHandle } from "./signals.js";
import { killProcessGroup } from "./signals.js";

export interface SpawnSpec {
  command: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  mode: PtyMode;
  cols?: number;
  rows?: number;
}

let ptyModule: typeof import("node-pty") | null | undefined;

export async function loadPty(): Promise<typeof import("node-pty") | null> {
  if (ptyModule !== undefined) return ptyModule;
  try {
    ptyModule = await import("node-pty");
    return ptyModule;
  } catch {
    ptyModule = null;
    return null;
  }
}

export function ptyAvailable(): boolean {
  return ptyModule !== null && ptyModule !== undefined;
}

export async function spawnCommand(spec: SpawnSpec): Promise<SpawnHandle> {
  const forceNever = spec.mode === "never";
  const wantPty = spec.mode === "always" || spec.mode === "auto";

  if (!forceNever && wantPty) {
    const pty = await loadPty();
    if (pty) {
      return spawnPty(pty, spec);
    }
    if (spec.mode === "always") {
      throw new Error(
        "PTY requested (--pty always) but node-pty is unavailable on this platform.",
      );
    }
  }
  return spawnPipes(spec);
}

function spawnPty(pty: typeof import("node-pty"), spec: SpawnSpec): SpawnHandle {
  const file = spec.command[0];
  const args = spec.command.slice(1);
  const cols = spec.cols || process.stdout.columns || 80;
  const rows = spec.rows || process.stdout.rows || 24;
  const proc = pty.spawn(file, args, {
    name: "xterm-256color",
    cols,
    rows,
    cwd: spec.cwd,
    env: spec.env as Record<string, string>,
  });
  const dataCbs: Array<(c: string) => void> = [];
  const exitCbs: Array<(code: number | null, signal: string | null) => void> = [];
  proc.onData((d) => {
    for (const cb of dataCbs) cb(d);
  });
  proc.onExit(({ exitCode, signal }) => {
    const sig = signal ? String(signal) : null;
    for (const cb of exitCbs) cb(exitCode ?? null, sig);
  });
  return {
    pid: proc.pid,
    pgid: proc.pid,
    pty: true,
    write: (d) => {
      try {
        proc.write(typeof d === "string" ? d : d.toString("utf8"));
      } catch {
        /* ignore */
      }
    },
    resize: (c, r) => {
      try {
        proc.resize(c, r);
      } catch {
        /* ignore */
      }
    },
    onData: (cb) => dataCbs.push(cb),
    onExit: (cb) => exitCbs.push(cb),
    kill: (signal = "SIGTERM") => killProcessGroup(proc.pid, signal),
    pause: () => {
      try {
        proc.pause();
      } catch {
        /* ignore */
      }
    },
    resume: () => {
      try {
        proc.resume();
      } catch {
        /* ignore */
      }
    },
  };
}

function spawnPipes(spec: SpawnSpec): SpawnHandle {
  const file = spec.command[0];
  const args = spec.command.slice(1);
  const detached = process.platform !== "win32";
  const child: ChildProcess = spawn(file, args, {
    cwd: spec.cwd,
    env: spec.env,
    stdio: ["inherit", "pipe", "pipe"],
    detached,
    windowsHide: true,
  });
  if (!child.pid) {
    throw new Error(`Failed to spawn ${file}`);
  }
  const dataCbs: Array<(c: string) => void> = [];
  const exitCbs: Array<(code: number | null, signal: string | null) => void> = [];
  const onChunk = (buf: Buffer) => {
    const s = buf.toString("utf8");
    for (const cb of dataCbs) cb(s);
  };
  child.stdout?.on("data", onChunk);
  child.stderr?.on("data", onChunk);
  child.on("error", (err) => {
    for (const cb of dataCbs) cb(`\n[flowpeek] spawn error: ${err.message}\n`);
    for (const cb of exitCbs) cb(1, null);
  });
  child.on("exit", (code, signal) => {
    for (const cb of exitCbs) cb(code, signal);
  });
  return {
    pid: child.pid,
    pgid: detached ? child.pid : undefined,
    pty: false,
    write: (d) => {
      try {
        child.stdin?.write(d);
      } catch {
        /* ignore */
      }
    },
    onData: (cb) => dataCbs.push(cb),
    onExit: (cb) => exitCbs.push(cb),
    kill: (signal = "SIGTERM") => killProcessGroup(child.pid!, signal),
    pause: () => {
      child.stdout?.pause();
      child.stderr?.pause();
    },
    resume: () => {
      child.stdout?.resume();
      child.stderr?.resume();
    },
    child,
  };
}
