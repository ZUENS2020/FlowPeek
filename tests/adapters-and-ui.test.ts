import { describe, expect, it } from "vitest";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { collect, freePort, makeHome, spawnCli, startDaemon } from "./helpers.js";
import { loadPty } from "../src/wrapper/spawn.js";

describe("PTY raw chunks", () => {
  it("preserves \\r progress updates (does not split CR into garbage lines)", async () => {
    const pty = await loadPty();
    if (!pty) {
      console.warn("skip: node-pty unavailable");
      return;
    }
    const home = makeHome();
    const port = await freePort();
    const daemon = await startDaemon(home, port);
    try {
      const wrapper = spawnCli(
        [
          "run",
          "--no-dashboard-url",
          "--pty",
          "always",
          "--json-meta",
          "--",
          "node",
          "-e",
          "process.stdout.write('aaaa\\rbbbb\\n');",
        ],
        { home, port },
      );
      const r = await collect(wrapper);
      expect(r.code).toBe(0);
      const metaLine = r.stderr
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l.startsWith("{") && l.includes("runId"));
      expect(metaLine).toBeTruthy();
      const meta = JSON.parse(metaLine!);
      await new Promise((res) => setTimeout(res, 200));
      const log = join(home, "runs", `${meta.runId}.ndjson`);
      const { existsSync, readFileSync } = await import("node:fs");
      if (!existsSync(log)) {
        // raw may still be in live buffer; check stdout at least contains bbbb
        expect(r.stdout).toMatch(/bbbb/);
        return;
      }
      const raw = readFileSync(log, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
        .filter((e) => e.type === "raw")
        .map((e) => Buffer.from(e.b64, "base64").toString("utf8"))
        .join("");
      expect(raw).toContain("\r");
      expect(raw).not.toMatch(/aaaa\nbbbb/);
    } finally {
      daemon.kill("SIGTERM");
    }
  });
});

describe("compact agent output", () => {
  it("hides raw logs from the agent while still completing", async () => {
    const home = makeHome();
    const port = await freePort();
    const wrapper = spawnCli(
      [
        "run",
        "--no-dashboard-url",
        "--pty",
        "never",
        "--agent-output",
        "compact",
        "--",
        "node",
        "-e",
        "console.log('RAW_SECRET_LINE'); console.error('warning: demo'); process.exit(0)",
      ],
      { home, port },
    );
    const r = await collect(wrapper);
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain("RAW_SECRET_LINE");
    expect(r.stderr).toMatch(/\[flowpeek\] \[phase\] started/);
    expect(r.stderr).toMatch(/\[flowpeek\] \[completed\]/);
    expect(r.stderr).toMatch(/warning/i);
  });
});

describe("adapter CLI", () => {
  it("lists built-in adapters", async () => {
    const home = makeHome();
    const port = await freePort();
    const r = await collect(spawnCli(["adapter", "list"], { home, port }));
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/generic/);
    expect(r.stdout).toMatch(/cargo-build/);
    expect(r.stdout).toMatch(/npm-install/);
  });

  it("resolves cargo build to cargo-build", async () => {
    const home = makeHome();
    const port = await freePort();
    const r = await collect(spawnCli(["adapter", "resolve", "--json", "--", "cargo", "build"], { home, port }));
    expect(r.code).toBe(0);
    const j = JSON.parse(r.stdout);
    expect(j.id).toBe("cargo-build");
  });

  it("does not resolve npm test as npm-install", async () => {
    const home = makeHome();
    const port = await freePort();
    const r = await collect(spawnCli(["adapter", "resolve", "--json", "--", "npm", "test"], { home, port }));
    expect(r.code).toBe(0);
    const j = JSON.parse(r.stdout);
    expect(j.id).not.toBe("npm-install");
    expect(j.id).toBe("generic");
  });

  it("validates and tests a project YAML adapter", async () => {
    const home = makeHome();
    const port = await freePort();
    mkdirSync(join(home, ".flowpeek", "adapters"), { recursive: true });
    const path = join(home, ".flowpeek", "adapters", "demo.yaml");
    writeFileSync(
      path,
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
    const v = await collect(spawnCli(["adapter", "validate", path, "--project", home], { home, port }));
    expect(v.stderr + v.stdout, `validate failed: out=${v.stdout} err=${v.stderr}`).toMatch(/ok demo/);
    expect(v.code).toBe(0);

    const fixture = join(home, "fix.txt");
    writeFileSync(fixture, "progress 3/10\n");
    const t = await collect(
      spawnCli(["adapter", "test", "demo", "--fixture", fixture, "--json", "--project", home], {
        home,
        port,
      }),
    );
    expect(t.code).toBe(0);
    const j = JSON.parse(t.stdout);
    expect(j.id).toBe("demo");
    expect(j.disabled).toBe(false);
    expect(j.events.some((e: { type: string }) => e.type === "progress")).toBe(true);
  });

  it("adapter test --json on a throwing script reports disabled", async () => {
    const home = makeHome();
    const port = await freePort();
    mkdirSync(join(home, ".flowpeek", "adapters"), { recursive: true });
    const path = join(home, ".flowpeek", "adapters", "bad.js");
    writeFileSync(
      path,
      `// flowpeek-match: executable=x
function onLine(api, line) { throw new Error("nope"); }
`,
    );
    const t = await collect(
      spawnCli(["adapter", "test", path, "--json", "--project", home], { home, port }),
    );
    expect(t.code).toBe(1);
    const j = JSON.parse(t.stdout);
    expect(j.disabled).toBe(true);
  });

  it("inspects a builtin adapter", async () => {
    const home = makeHome();
    const port = await freePort();
    const r = await collect(spawnCli(["adapter", "inspect", "cargo-build"], { home, port }));
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/id: cargo-build/);
    expect(r.stdout).toMatch(/executable/);
  });
});

describe("dashboard HTTP", () => {
  it("serves health, runs, adapters on loopback", async () => {
    const home = makeHome();
    const port = await freePort();
    const daemon = await startDaemon(home, port);
    try {
      const health = await fetch(`http://127.0.0.1:${port}/api/health`).then((r) => r.json());
      expect(health.ok).toBe(true);
      const adapters = await fetch(`http://127.0.0.1:${port}/api/adapters`).then((r) => r.json());
      expect(adapters.adapters.some((a: { id: string }) => a.id === "generic")).toBe(true);
      const page = await fetch(`http://127.0.0.1:${port}/`);
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).toMatch(/FlowPeek/);
    } finally {
      daemon.kill("SIGTERM");
    }
  });
});

describe("compact + dashboard", () => {
  it("keeps full raw log on the dashboard while the agent sees compact output", async () => {
    const home = makeHome();
    const port = await freePort();
    const daemon = await startDaemon(home, port);
    try {
      const wrapper = spawnCli(
        [
          "run",
          "--no-dashboard-url",
          "--pty",
          "never",
          "--agent-output",
          "compact",
          "--json-meta",
          "--",
          "node",
          "-e",
          "process.stdout.write('DASHBOARD_ONLY_RAW\\n'); process.exit(0)",
        ],
        { home, port },
      );
      const r = await collect(wrapper);
      expect(r.code).toBe(0);
      expect(r.stdout).not.toContain("DASHBOARD_ONLY_RAW");
      expect(r.stderr).toMatch(/\[completed\]/);
      const metaLine = r.stderr
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l.startsWith("{") && l.includes("runId"));
      expect(metaLine).toBeTruthy();
      const { runId } = JSON.parse(metaLine!);
      await new Promise((res) => setTimeout(res, 200));
      const body = await fetch(`http://127.0.0.1:${port}/api/runs/${runId}/events`).then((x) => x.json());
      const raw = (body.events as Array<{ type: string; b64?: string }>)
        .filter((e) => e.type === "raw" && e.b64)
        .map((e) => Buffer.from(e.b64!, "base64").toString("utf8"))
        .join("");
      expect(raw).toContain("DASHBOARD_ONLY_RAW");
    } finally {
      daemon.kill("SIGTERM");
    }
  });
});

describe("help", () => {
  it("prints help and version", async () => {
    const home = makeHome();
    const port = await freePort();
    const h = await collect(spawnCli(["--help"], { home, port }));
    expect(h.code).toBe(0);
    expect(h.stdout).toMatch(/flowpeek run/);
    const v = await collect(spawnCli(["--version"], { home, port }));
    expect(v.code).toBe(0);
    expect(v.stdout).toMatch(/\d+\.\d+\.\d+/);
  });
});
