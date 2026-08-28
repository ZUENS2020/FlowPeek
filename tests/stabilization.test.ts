import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cmdAdapterScaffold, scriptAdapterSource } from "../src/adapters/cli.js";
import { replayAdapter } from "../src/adapters/engine.js";
import { parseAdapterFile } from "../src/adapters/resolve.js";
import { ScriptSandbox } from "../src/adapters/sandbox.js";
import { RunRegistry } from "../src/collector/registry.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { closeDb } from "../src/storage/db.js";
import type { RunRecord } from "../src/types.js";
import { loadPty } from "../src/wrapper/spawn.js";
import { collect, freePort, makeHome, spawnCli } from "./helpers.js";

describe("script adapter scaffold matches QuickJS runtime API", () => {
  it("does not take `api` as a hook argument; uses the injected global", async () => {
    const src = scriptAdapterSource("my-tool");
    expect(src).toMatch(/function onStart\s*\(\s*\)/);
    expect(src).toMatch(/function onLine\s*\(\s*line\s*\)/);
    expect(src).toMatch(/function onExit\s*\(\s*code\s*\)/);
    expect(src).not.toMatch(/function onStart\s*\(\s*api/);
    expect(src).not.toMatch(/function onLine\s*\(\s*api/);
    expect(src).not.toMatch(/function onExit\s*\(\s*api/);

    const home = makeHome();
    expect(cmdAdapterScaffold("my-tool", "script", home)).toBe(0);
    const path = join(home, ".flowpeek", "adapters", "my-tool.js");
    expect(readFileSync(path, "utf8")).toBe(src);

    const resolved = { spec: parseAdapterFile(path), source: "project" as const, path };
    const result = await replayAdapter(
      resolved,
      "progress 3/10\nwarning: unused\nerror: boom\n",
    );
    expect(result.disabled, result.reason).toBe(false);
    expect(result.events.some((e) => e.type === "phase" && e.phase === "running")).toBe(true);
    const prog = result.events.find((e) => e.type === "progress");
    expect(prog?.progress?.current).toBe(3);
    expect(prog?.progress?.total).toBe(10);
    expect(result.events.some((e) => e.type === "warning" && e.message?.includes("unused"))).toBe(true);
    expect(result.events.some((e) => e.type === "error" && e.message?.includes("boom"))).toBe(true);
    expect(result.events.some((e) => e.phase === "complete")).toBe(true);
  });
});

describe("QuickJS CPU interrupt during initial eval", () => {
  it("disables an adapter whose script body busy-loops instead of hanging", async () => {
    const warm = new ScriptSandbox();
    await warm.init("function onStart() {}", () => undefined);
    warm.dispose();

    const sb = new ScriptSandbox();
    const t0 = Date.now();
    await sb.init("let i = 0; while (true) { i = i + 1; }", () => undefined);
    const elapsed = Date.now() - t0;
    try {
      expect(sb.disabled).toBe(true);
      expect(sb.disableReason).toMatch(/eval failed|interrupt/i);
      expect(elapsed).toBeLessThan(3000);
    } finally {
      sb.dispose();
    }
  });
});

describe("PTY stdin forwarding", () => {
  it("transparently forwards wrapper stdin to a PTY child", async () => {
    const pty = await loadPty();
    if (!pty) {
      console.warn("skip: node-pty unavailable");
      return;
    }
    const home = makeHome();
    const port = await freePort();
    const wrapper = spawnCli(
      [
        "run",
        "--no-dashboard-url",
        "--pty",
        "always",
        "--",
        "node",
        "-e",
        `
          process.stdin.on("data", (d) => {
            process.stdout.write("GOT:" + d.toString());
            process.exit(0);
          });
          setTimeout(() => process.exit(2), 8000);
        `,
      ],
      { home, port, stdio: ["pipe", "pipe", "pipe"] },
    );
    await new Promise((r) => setTimeout(r, 400));
    wrapper.stdin?.write("from-parent\n");
    const r = await collect(wrapper);
    expect(r.code, `stderr=${r.stderr}`).toBe(0);
    expect(r.stdout).toContain("GOT:from-parent");
  });
});

describe("non-PTY stdout/stderr separation", () => {
  it("writes child stdout and stderr to the matching wrapper streams", async () => {
    const home = makeHome();
    const port = await freePort();
    const wrapper = spawnCli(
      [
        "run",
        "--no-dashboard-url",
        "--pty",
        "never",
        "--",
        "node",
        "-e",
        "process.stdout.write('STDOUT_ONLY'); process.stderr.write('STDERR_ONLY');",
      ],
      { home, port },
    );
    const r = await collect(wrapper);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("STDOUT_ONLY");
    expect(r.stdout).not.toContain("STDERR_ONLY");
    expect(r.stderr).toContain("STDERR_ONLY");
    expect(r.stderr).not.toContain("STDOUT_ONLY");
  });
});

describe("telemetry reconnection restores running state", () => {
  let home: string;

  beforeEach(() => {
    closeDb();
    home = makeHome();
    process.env.FLOWPEEK_HOME = home;
  });

  afterEach(() => {
    closeDb();
  });

  function makeRun(id: string): RunRecord {
    return {
      id,
      sessionId: id,
      rootRunId: id,
      command: ["echo", "hi"],
      cwd: home,
      startedAt: new Date().toISOString(),
      status: "running",
      processState: "running",
      pty: false,
      agentOutput: "passthrough",
      droppedRawChunks: 0,
      droppedRawBytes: 0,
      telemetryConnected: true,
    };
  }

  it("restores processState=running after hello/heartbeat/raw reconnect", () => {
    const registry = new RunRegistry(DEFAULT_CONFIG);
    const run = makeRun("run-restore-1");
    const live = registry.startRun(run, home);

    registry.markTelemetryLost(run.id);
    expect(live.run.telemetryConnected).toBe(false);
    expect(live.run.processState).toBe("unknown");
    expect(live.run.status).toBe("unknown");

    registry.markTelemetryRestored(run.id);
    expect(live.run.telemetryConnected).toBe(true);
    expect(live.run.processState).toBe("running");
    expect(live.run.status).toBe("running");
    expect(live.run.telemetryDisconnectedAt).toBeUndefined();

    registry.markTelemetryLost(run.id);
    registry.heartbeat(run.id, 0);
    expect(live.run.processState).toBe("running");
    expect(live.run.telemetryConnected).toBe(true);

    registry.markTelemetryLost(run.id);
    registry.ingestRaw(run.id, Buffer.from("x").toString("base64"), 1);
    expect(live.run.processState).toBe("running");
    expect(live.run.telemetryConnected).toBe(true);

    live.adapter?.dispose();
  });

  it("does not un-exit a finished run when telemetry reconnects", () => {
    const registry = new RunRegistry(DEFAULT_CONFIG);
    const run = makeRun("run-restore-2");
    const live = registry.startRun(run, home);
    registry.exit(run.id, 0, null, new Date().toISOString());
    registry.markTelemetryRestored(run.id);
    expect(live.run.processState).toBe("exited");
    expect(live.run.status).toBe("exited");
    live.adapter?.dispose();
  });
});
