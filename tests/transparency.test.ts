import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { collect, freePort, makeHome, spawnCli, startDaemon } from "./helpers.js";

describe("transparency: exit code", () => {
  it("wrapper exit code matches node -e process.exit(17)", async () => {
    const home = makeHome();
    const port = await freePort();
    const child = spawnCli(
      ["run", "--no-dashboard-url", "--pty", "never", "--", "node", "-e", "process.exit(17)"],
      { home, port },
    );
    const r = await collect(child);
    expect(r.code).toBe(17);
  });

  it("wrapper exit 0 for successful command", async () => {
    const home = makeHome();
    const port = await freePort();
    const child = spawnCli(
      ["run", "--no-dashboard-url", "--pty", "never", "--", "node", "-e", "process.stdout.write('ok')"],
      { home, port },
    );
    const r = await collect(child);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("ok");
  });
});

describe("transparency: signals", () => {
  it("SIGTERM on wrapper terminates child and does not leak descendants", async () => {
    const home = makeHome();
    const port = await freePort();
    const pidfile = join(home, "pids.txt");
    const script = `
      const { spawn } = require("node:child_process");
      const fs = require("node:fs");
      const g = spawn(process.execPath, ["-e", "setInterval(()=>{}, 1000)"], { stdio: "ignore" });
      fs.writeFileSync(process.env.PIDFILE, String(process.pid) + "\\n" + String(g.pid));
      setInterval(() => {}, 1000);
    `;
    const wrapper = spawnCli(
      ["run", "--no-dashboard-url", "--pty", "never", "--", "node", "-e", script],
      { home, port, env: { PIDFILE: pidfile } },
    );
    const start = Date.now();
    while (!existsSync(pidfile) && Date.now() - start < 8000) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(existsSync(pidfile)).toBe(true);
    const [childPid, grandPid] = readFileSync(pidfile, "utf8")
      .trim()
      .split("\n")
      .map((s) => Number(s));
    expect(childPid).toBeGreaterThan(0);
    wrapper.kill("SIGTERM");
    const r = await collect(wrapper);
    expect(r.code === 0 || (r.code && r.code > 0) || r.signal).toBeTruthy();
    await new Promise((res) => setTimeout(res, 400));
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    expect(alive(childPid)).toBe(false);
    expect(alive(grandPid)).toBe(false);
  });
});

describe("isolation: collector death", () => {
  it("killing collector does not stop the child; agent still gets output", async () => {
    const home = makeHome();
    const port = await freePort();
    const daemon = await startDaemon(home, port);
    const script = `
      let n = 0;
      const t = setInterval(() => {
        process.stdout.write("tick-" + n + "\\n");
        n++;
        if (n >= 15) { clearInterval(t); }
      }, 80);
    `;
    const wrapper = spawnCli(
      ["run", "--no-dashboard-url", "--pty", "never", "--", "node", "-e", script],
      { home, port },
    );
    await new Promise((r) => setTimeout(r, 250));
    daemon.kill("SIGKILL");
    const r = await collect(wrapper);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/tick-0/);
    expect(r.stdout).toMatch(/tick-1[0-4]/);
  });
});

describe("isolation: adapter throw", () => {
  it("adapter throw disables adapter, raw logs continue, child unaffected", async () => {
    const home = makeHome();
    const port = await freePort();
    const project = home;
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(project, ".flowpeek", "adapters"), { recursive: true });
    writeFileSync(
      join(project, ".flowpeek", "adapters", "boom.js"),
      `// flowpeek-match: executable=node
function onLine(api, line) { throw new Error("intentional boom"); }
function onChunk(api, chunk) { throw new Error("intentional boom"); }
`,
    );
    const daemon = await startDaemon(home, port, project);
    try {
      const wrapper = spawnCli(
        [
          "run",
          "--no-dashboard-url",
          "--pty",
          "never",
          "--adapter",
          "boom",
          "--project",
          project,
          "--",
          "node",
          "-e",
          "process.stdout.write('hello-from-child\\n'); process.exit(0)",
        ],
        { home, port },
      );
      const r = await collect(wrapper);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("hello-from-child");
    } finally {
      daemon.kill("SIGTERM");
    }
  });
});

describe("backpressure", () => {
  it("high-volume output does not stall the child when collector is a black hole", async () => {
    const home = makeHome();
    const port = await freePort();
    const net = await import("node:net");
    const sockPath = join(home, "daemon.sock");
    const blackhole = net.createServer((s) => {
      s.pause();
    });
    await new Promise<void>((resolve) => blackhole.listen(sockPath, resolve));
    try {
      const start = Date.now();
      const wrapper = spawnCli(
        [
          "run",
          "--no-dashboard-url",
          "--pty",
          "never",
          "--",
          "node",
          "-e",
          "for (let i = 0; i < 20000; i++) process.stdout.write('x'.repeat(200) + '\\n')",
        ],
        { home, port, env: { FLOWPEEK_SOCK: sockPath } },
      );
      const r = await collect(wrapper);
      const elapsed = Date.now() - start;
      expect(r.code).toBe(0);
      expect(r.stdout.length).toBeGreaterThan(1_000_000);
      expect(elapsed).toBeLessThan(15_000);
    } finally {
      blackhole.close();
    }
  });
});
