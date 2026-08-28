import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collect, freePort, makeHome, spawnCli } from "./helpers.js";

describe("flowpeek probe", () => {
  it("captures raw CR/ANSI output without registering a dashboard run", async () => {
    const home = makeHome();
    const port = await freePort();
    const result = await collect(
      spawnCli(
        [
          "probe",
          "--json",
          "--pty",
          "never",
          "--project",
          home,
          "--",
          "node",
          "-e",
          "process.stdout.write('\\u001b[31mred\\u001b[0m\\rnext\\n')",
        ],
        { home, port },
      ),
    );
    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    const report = JSON.parse(result.stdout);
    expect(report.stopReason).toBe("exited");
    expect(report.childExitCode).toBe(0);
    expect(report.lines).toBe(2);
    expect(readFileSync(report.fixture, "utf8")).toBe("\u001b[31mred\u001b[0m\rnext\n");
    expect(existsSync(join(home, "flowpeek.db"))).toBe(false);
  });

  it.each([
    ["time_limit", ["--max-seconds", "0.1"], "setInterval(() => process.stdout.write('tick\\n'), 20)"],
    ["byte_limit", ["--max-bytes", "32b"], "process.stdout.write('x'.repeat(1024)); setInterval(()=>{}, 1000)"],
    ["line_limit", ["--max-lines", "2"], "process.stdout.write('one\\ntwo\\nthree\\n'); setInterval(()=>{}, 1000)"],
  ])("stops on %s and still returns capture success", async (reason, limitArgs, script) => {
    const home = makeHome();
    const port = await freePort();
    const result = await collect(
      spawnCli(
        ["probe", "--json", "--pty", "never", "--project", home, ...limitArgs, "--", "node", "-e", script],
        { home, port },
      ),
    );
    expect(result.code, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.stopReason).toBe(reason);
    expect(existsSync(report.fixture)).toBe(true);
  });

  it("returns nonzero when the fixture directory cannot be created", async () => {
    const home = makeHome();
    const port = await freePort();
    const notDirectory = join(home, "project-file");
    writeFileSync(notDirectory, "x");
    const result = await collect(
      spawnCli(["probe", "--project", notDirectory, "--", "node", "-e", "0"], { home, port }),
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/cannot create fixture directory/);
  });

  it("stops descendants in the sampled process group", async () => {
    const home = makeHome();
    const port = await freePort();
    const pidfile = join(home, "probe-pids.txt");
    const script = `
      const { spawn } = require("node:child_process");
      const fs = require("node:fs");
      const child = spawn(process.execPath, ["-e", "setInterval(()=>{}, 1000)"], { stdio: "ignore" });
      fs.writeFileSync(process.env.PIDFILE, process.pid + "\\n" + child.pid);
      setInterval(()=>{}, 1000);
    `;
    const result = await collect(
      spawnCli(
        ["probe", "--json", "--pty", "never", "--project", home, "--max-seconds", "0.2", "--", "node", "-e", script],
        { home, port, env: { PIDFILE: pidfile } },
      ),
    );
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).stopReason).toBe("time_limit");
    const pids = readFileSync(pidfile, "utf8").trim().split("\n").map(Number);
    await new Promise((resolve) => setTimeout(resolve, 200));
    for (const pid of pids) {
      expect(() => process.kill(pid, 0)).toThrow();
    }
  });
});

describe("strict adapter report", () => {
  it("counts only adapter fixture matches and emits a stable JSON report", async () => {
    const home = makeHome();
    const port = await freePort();
    const dir = join(home, ".flowpeek", "adapters");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "demo.yaml"),
      `id: demo
name: Demo
match:
  executable: demo
patterns:
  - regex: "progress (\\\\d+)/(\\\\d+)"
    kind: progress
    current: "{1}"
    total: "{2}"
`,
    );
    const fixture = join(home, "fixture.log");
    writeFileSync(fixture, "warning: generic only\nprogress 3/10\n");
    const result = await collect(
      spawnCli(
        ["adapter", "test", "demo", "--fixture", fixture, "--report", "--json", "--project", home],
        { home, port },
      ),
    );
    expect(result.code, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.result).toBe("PASS");
    expect(report.input.lines).toBe(2);
    expect(report.matched.progress).toBe(1);
    expect(report.matched.warning).toBe(0);
    expect(report.progress.latest).toMatchObject({ current: 3, total: 10 });
  });

  it("fails a script whose lifecycle emits but fixture lines do not match", async () => {
    const home = makeHome();
    const port = await freePort();
    const adapter = join(home, "no-match.js");
    const fixture = join(home, "fixture.log");
    writeFileSync(adapter, "function onStart(){ api.phase('started') } function onLine(line){ if (line === 'yes') api.activity(line) }");
    writeFileSync(fixture, "no\n");
    const result = await collect(
      spawnCli(["adapter", "test", adapter, "--fixture", fixture, "--report", "--json"], { home, port }),
    );
    expect(result.code).toBe(1);
    const report = JSON.parse(result.stdout);
    expect(report.result).toBe("FAIL");
    expect(report.reason).toMatch(/no adapter events/);
    expect(Object.values(report.matched).reduce((sum: number, value) => sum + Number(value), 0)).toBe(0);
  });

  it("fails when the sandbox disables during fixture processing", async () => {
    const home = makeHome();
    const port = await freePort();
    const adapter = join(home, "throws.js");
    const fixture = join(home, "fixture.log");
    writeFileSync(adapter, "function onLine(){ throw new Error('boom') }");
    writeFileSync(fixture, "line\n");
    const result = await collect(
      spawnCli(["adapter", "test", adapter, "--fixture", fixture, "--report", "--json"], { home, port }),
    );
    expect(result.code).toBe(1);
    const report = JSON.parse(result.stdout);
    expect(report.disabled).toBe(true);
    expect(report.disabledReason).toMatch(/boom/);
  });
});
