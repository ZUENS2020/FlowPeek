import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

export function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "flowpeek-"));
  mkdirSync(join(home, "runs"), { recursive: true });
  mkdirSync(join(home, "adapters"), { recursive: true });
  writeFileSync(
    join(home, "config.yaml"),
    `dashboard:\n  auto_start: false\n  host: 127.0.0.1\n`,
  );
  return home;
}

export async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      s.close(() => {
        if (addr && typeof addr === "object") resolve(addr.port);
        else reject(new Error("no port"));
      });
    });
    s.on("error", reject);
  });
}

export function avEnv(home: string, port: number, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = {
    ...process.env,
    FLOWPEEK_HOME: home,
    FLOWPEEK_PORT: String(port),
    FLOWPEEK_HOST: "127.0.0.1",
    FLOWPEEK_SOCK: join(home, "daemon.sock"),
    ...extra,
  };
  for (const key of ["FLOWPEEK_RUN_ID", "FLOWPEEK_SESSION_ID", "FLOWPEEK_ROOT_RUN_ID", "FLOWPEEK_AGENT_NAME"]) {
    if (!(key in extra)) delete env[key];
  }
  return env;
}

export function spawnCli(
  args: string[],
  opts: { home: string; port: number; cwd?: string; env?: NodeJS.ProcessEnv } & SpawnOptions,
): ChildProcess {
  return spawn(process.execPath, ["--import", "tsx", CLI, ...args], {
    // Always launch from the package root so `--import tsx` resolves.
    cwd: ROOT,
    env: avEnv(opts.home, opts.port, opts.env),
    stdio: opts.stdio ?? ["ignore", "pipe", "pipe"],
  });
}

export function collect(child: ChildProcess): Promise<{ code: number | null; signal: string | null; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (d) => {
    stdout += d.toString("utf8");
  });
  child.stderr?.on("data", (d) => {
    stderr += d.toString("utf8");
  });
  return new Promise((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

export async function waitHealth(port: number, ms = 8000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (r.ok) return true;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 80));
  }
  return false;
}

export async function startDaemon(home: string, port: number, project?: string): Promise<ChildProcess> {
  const args = ["daemon", "--foreground"];
  if (project) args.push("--project", project);
  const child = spawnCli(args, { home, port });
  let err = "";
  child.stderr?.on("data", (d) => {
    err += d.toString("utf8");
  });
  const ok = await waitHealth(port, 12_000);
  if (!ok) {
    child.kill("SIGTERM");
    throw new Error(`daemon did not become healthy on ${port}: ${err || "(no stderr)"}`);
  }
  return child;
}

export function writeProjectAdapter(project: string, filename: string, body: string): string {
  const dir = join(project, ".flowpeek", "adapters");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, filename);
  writeFileSync(path, body);
  return path;
}
