import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { PtyMode } from "../types.js";
import type { IoStream, SpawnHandle } from "./signals.js";
import { killProcessGroup } from "./signals.js";

const require = createRequire(import.meta.url);

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

export function spawnHelperPaths(): string[] {
  try {
    const pkg = dirname(require.resolve("node-pty/package.json"));
    return [
      join(pkg, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper"),
      join(pkg, "build", "Release", "spawn-helper"),
    ].filter((p) => existsSync(p));
  } catch {
    return [];
  }
}

/** npm/pack often drops the execute bit on node-pty's spawn-helper; posix_spawnp then fails. */
export function ensureSpawnHelperExecutable(): void {
  for (const p of spawnHelperPaths()) {
    try {
      chmodSync(p, 0o755);
    } catch {
      /* ignore — spawn may still work, or auto will fall back to pipes */
    }
  }
}

export async function spawnCommand(spec: SpawnSpec): Promise<SpawnHandle> {
  const forceNever = spec.mode === "never";
  const wantPty = spec.mode === "always" || spec.mode === "auto";

  if (!forceNever && wantPty) {
    const pty = await loadPty();
    if (pty) {
      ensureSpawnHelperExecutable();
      try {
        return spawnPty(pty, spec);
      } catch (err) {
        if (spec.mode === "always") {
          throw err instanceof Error ? err : new Error(String(err));
        }
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[flowpeek] PTY spawn failed (${msg}); falling back to pipes\n`);
        return spawnPipes(spec);
      }
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
  const dataCbs: Array<(c: string, stream: IoStream) => void> = [];
  const exitCbs: Array<(code: number | null, signal: string | null) => void> = [];
  proc.onData((d) => {
    for (const cb of dataCbs) cb(d, "stdout");
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
  const dataCbs: Array<(c: string, stream: IoStream) => void> = [];
  const exitCbs: Array<(code: number | null, signal: string | null) => void> = [];
  const emit = (stream: IoStream, buf: Buffer | string) => {
    const s = typeof buf === "string" ? buf : buf.toString("utf8");
    for (const cb of dataCbs) cb(s, stream);
  };
  child.stdout?.on("data", (buf: Buffer) => emit("stdout", buf));
  child.stderr?.on("data", (buf: Buffer) => emit("stderr", buf));
  child.on("error", (err) => {
    emit("stderr", `\n[flowpeek] spawn error: ${err.message}\n`);
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
