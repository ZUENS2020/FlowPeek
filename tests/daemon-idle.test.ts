import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { IdleShutdownTracker } from "../src/collector/idle.js";
import { collect, freePort, makeHome, spawnCli, waitHealth } from "./helpers.js";

describe("daemon idle tracker", () => {
  it("stops only after the configured unused interval", () => {
    let now = 0;
    const tracker = new IdleShutdownTracker(1000, () => now);
    now = 999;
    expect(tracker.shouldStop(false)).toBe(false);
    now = 1000;
    expect(tracker.shouldStop(false)).toBe(true);

    expect(tracker.shouldStop(true)).toBe(false);
    now = 1999;
    expect(tracker.shouldStop(false)).toBe(false);
    now = 2000;
    expect(tracker.shouldStop(false)).toBe(true);
  });

  it("resets on explicit run activity and supports disabling idle shutdown", () => {
    let now = 0;
    const tracker = new IdleShutdownTracker(100, () => now);
    now = 50;
    tracker.touch();
    now = 149;
    expect(tracker.shouldStop(false)).toBe(false);
    now = 150;
    expect(tracker.shouldStop(false)).toBe(true);

    expect(new IdleShutdownTracker(0, () => 1_000_000).shouldStop(false)).toBe(false);
  });
});

describe("daemon idle auto-stop", () => {
  it("exits after no runs or viewers use it", async () => {
    const home = makeHome();
    const port = await freePort();
    const daemon = spawnCli(["daemon", "--foreground"], {
      home,
      port,
      env: { FLOWPEEK_IDLE_SECONDS: "0.3" },
    });
    try {
      expect(await waitHealth(port)).toBe(true);
      const result = await collectWithin(daemon, 2500);
      expect(result.code).toBe(0);
      expect(result.stderr).toMatch(/daemon idle for 0\.3s; stopping/);
      expect(existsSync(join(home, "daemon.pid"))).toBe(false);
    } finally {
      if (daemon.exitCode == null) daemon.kill("SIGTERM");
    }
  });

  it("stays alive for an active run, then exits after the run finishes", async () => {
    const home = makeHome();
    const port = await freePort();
    const daemon = spawnCli(["daemon", "--foreground"], {
      home,
      port,
      env: { FLOWPEEK_IDLE_SECONDS: "0.25" },
    });
    try {
      expect(await waitHealth(port)).toBe(true);
      const wrapper = spawnCli([
        "run", "--no-dashboard-url", "--pty", "never", "--",
        "node", "-e", "setTimeout(() => {}, 700)",
      ], { home, port });
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(daemon.exitCode).toBeNull();
      expect((await collect(wrapper)).code).toBe(0);
      expect((await collectWithin(daemon, 2500)).code).toBe(0);
    } finally {
      if (daemon.exitCode == null) daemon.kill("SIGTERM");
    }
  });

  it("still exits when an idle Web or TUI viewer keeps polling", async () => {
    const home = makeHome();
    const port = await freePort();
    const daemon = spawnCli(["daemon", "--foreground"], {
      home,
      port,
      env: { FLOWPEEK_IDLE_SECONDS: "0.25" },
    });
    let poll: NodeJS.Timeout | undefined;
    try {
      expect(await waitHealth(port)).toBe(true);
      poll = setInterval(() => {
        void fetch(`http://127.0.0.1:${port}/api/health`).catch(() => undefined);
      }, 50);
      const result = await collectWithin(daemon, 2500);
      expect(result.code).toBe(0);
      expect(result.stderr).toMatch(/daemon idle/);
    } finally {
      if (poll) clearInterval(poll);
      if (daemon.exitCode == null) daemon.kill("SIGTERM");
    }
  });
});

async function collectWithin(child: ChildProcess, timeoutMs: number) {
  return await Promise.race([
    collect(child),
    new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error(`process did not exit within ${timeoutMs}ms`)), timeoutMs);
      timer.unref?.();
    }),
  ]);
}
