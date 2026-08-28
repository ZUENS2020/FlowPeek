import { chmodSync, statSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  ensureSpawnHelperExecutable,
  loadPty,
  spawnCommand,
  spawnHelperPaths,
} from "../src/wrapper/spawn.js";

describe("spawn-helper execute bit", () => {
  it("restores +x on node-pty spawn-helper", () => {
    const helpers = spawnHelperPaths();
    if (!helpers.length) {
      console.warn("skip: spawn-helper not found");
      return;
    }
    const p = helpers[0];
    chmodSync(p, 0o644);
    expect(statSync(p).mode & 0o111).toBe(0);
    ensureSpawnHelperExecutable();
    expect(statSync(p).mode & 0o111).toBeTruthy();
  });
});

describe("PTY auto fallback", () => {
  it("falls back to pipes when pty.spawn throws", async () => {
    const pty = await loadPty();
    if (!pty) {
      console.warn("skip: node-pty unavailable");
      return;
    }
    const spy = vi.spyOn(pty, "spawn").mockImplementation(() => {
      throw new Error("posix_spawnp failed.");
    });
    try {
      const h = await spawnCommand({
        command: [process.execPath, "-e", "process.stdout.write('piped-ok')"],
        cwd: process.cwd(),
        env: process.env,
        mode: "auto",
      });
      expect(h.pty).toBe(false);
      let out = "";
      h.onData((c) => {
        out += c;
      });
      const code = await new Promise<number | null>((resolve) => h.onExit((c) => resolve(c)));
      expect(code).toBe(0);
      expect(out).toContain("piped-ok");
    } finally {
      spy.mockRestore();
    }
  });

  it("--pty always still fails when pty.spawn throws", async () => {
    const pty = await loadPty();
    if (!pty) {
      console.warn("skip: node-pty unavailable");
      return;
    }
    const spy = vi.spyOn(pty, "spawn").mockImplementation(() => {
      throw new Error("posix_spawnp failed.");
    });
    try {
      await expect(
        spawnCommand({
          command: [process.execPath, "-e", "0"],
          cwd: process.cwd(),
          env: process.env,
          mode: "always",
        }),
      ).rejects.toThrow(/posix_spawnp/);
    } finally {
      spy.mockRestore();
    }
  });
});
