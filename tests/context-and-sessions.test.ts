import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { childEnvForContext, resolveRunContext } from "../src/context.js";
import { RunRegistry, summarizeSession } from "../src/collector/registry.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { closeDb, getDb, getRun } from "../src/storage/db.js";
import type { RunRecord } from "../src/types.js";
import { collect, freePort, makeHome, spawnCli, startDaemon } from "./helpers.js";
import { join } from "node:path";
import { existsSync } from "node:fs";

const originalFlowpeekHome = process.env.FLOWPEEK_HOME;

function run(id: string, patch: Partial<RunRecord> = {}): RunRecord {
  return {
    id,
    sessionId: "session-a",
    rootRunId: id,
    command: ["echo", id],
    cwd: "/tmp/project",
    startedAt: "2026-08-28T00:00:00.000Z",
    status: "exited",
    processState: "exited",
    pty: false,
    agentOutput: "passthrough",
    droppedRawChunks: 0,
    droppedRawBytes: 0,
    telemetryConnected: true,
    ...patch,
  };
}

describe("native execution context", () => {
  it("creates an independent session for a top-level run", () => {
    const ctx = resolveRunContext({ runId: "run-a", env: {} });
    expect(ctx.sessionId).toMatch(/^s/);
    expect(ctx.parentRunId).toBeUndefined();
    expect(ctx.rootRunId).toBe("run-a");
  });

  it("links a nested wrapper only when the selected session matches", () => {
    const env = {
      FLOWPEEK_SESSION_ID: "session-a",
      FLOWPEEK_RUN_ID: "parent-a",
      FLOWPEEK_ROOT_RUN_ID: "root-a",
      FLOWPEEK_AGENT_NAME: "Codex",
    };
    expect(resolveRunContext({ runId: "child", env })).toEqual({
      sessionId: "session-a",
      parentRunId: "parent-a",
      rootRunId: "root-a",
      agentName: "Codex",
    });
    expect(resolveRunContext({ runId: "detached", sessionId: "session-b", env })).toEqual({
      sessionId: "session-b",
      parentRunId: undefined,
      rootRunId: "detached",
      agentName: "Codex",
    });
  });

  it("injects the current run context into the real child environment", () => {
    const env = childEnvForContext(
      { KEEP: "yes" },
      "current",
      { sessionId: "session-a", parentRunId: "parent", rootRunId: "root", agentName: "Cursor" },
    );
    expect(env).toMatchObject({
      KEEP: "yes",
      FLOWPEEK_RUN_ID: "current",
      FLOWPEEK_SESSION_ID: "session-a",
      FLOWPEEK_ROOT_RUN_ID: "root",
      FLOWPEEK_AGENT_NAME: "Cursor",
    });
  });

  it("session-id prints a reusable generated id", async () => {
    const home = makeHome();
    const port = await freePort();
    const result = await collect(spawnCli(["session-id"], { home, port }));
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toMatch(/^s/);
  });

  it("propagates context to the child and exposes it in json metadata", async () => {
    const home = makeHome();
    const port = await freePort();
    const result = await collect(
      spawnCli(
        [
          "run",
          "--no-dashboard-url",
          "--json-meta",
          "--pty",
          "never",
          "--agent",
          "Codex",
          "--",
          "node",
          "-e",
          "process.stdout.write([process.env.FLOWPEEK_SESSION_ID,process.env.FLOWPEEK_RUN_ID,process.env.FLOWPEEK_ROOT_RUN_ID,process.env.FLOWPEEK_AGENT_NAME].join('|'))",
        ],
        { home, port },
      ),
    );
    expect(result.code).toBe(0);
    const meta = JSON.parse(result.stderr.trim());
    expect(meta.sessionId).toMatch(/^s/);
    expect(meta.rootRunId).toBe(meta.runId);
    expect(meta.parentRunId).toBeNull();
    expect(meta.agentName).toBe("Codex");
    expect(result.stdout).toBe(`${meta.sessionId}|${meta.runId}|${meta.runId}|Codex`);
  });

  it("groups active roots and removes the session after every run exits", async () => {
    const home = makeHome();
    const port = await freePort();
    const daemon = await startDaemon(home, port);
    try {
      const wrappers = ["first", "second"].map((label) =>
        spawnCli(
          ["run", "--no-dashboard-url", "--json-meta", "--pty", "never", "--session", "shared-session", "--agent", "Codex", "--label", label, "--", "node", "-e", "setTimeout(() => {}, 1200)"],
          { home, port },
        ),
      );
      await new Promise((resolve) => setTimeout(resolve, 250));
      const list = await fetch(`http://127.0.0.1:${port}/api/sessions`).then((response) => response.json());
      const session = list.sessions.find((item: { id: string }) => item.id === "shared-session");
      expect(session).toMatchObject({ agentName: "Codex", runCount: 2, rootCount: 2, runningCount: 2, status: "running" });
      const detail = await fetch(`http://127.0.0.1:${port}/api/sessions/shared-session`).then((response) => response.json());
      expect(detail.runs).toHaveLength(2);
      expect(detail.runs.every((item: RunRecord) => item.rootRunId === item.id)).toBe(true);
      const page = await fetch(`http://127.0.0.1:${port}/s/shared-session`);
      expect(page.status).toBe(200);
      expect(await page.text()).toMatch(/FlowPeek/);

      const results = await Promise.all(wrappers.map(collect));
      expect(results.every((result) => result.code === 0)).toBe(true);
      const runIds = results.map((result) => JSON.parse(result.stderr.trim()).runId as string);
      await new Promise((resolve) => setTimeout(resolve, 150));
      const after = await fetch(`http://127.0.0.1:${port}/api/sessions`).then((response) => response.json());
      expect(after.sessions.some((item: { id: string }) => item.id === "shared-session")).toBe(false);
      expect((await fetch(`http://127.0.0.1:${port}/api/sessions/shared-session`)).status).toBe(404);
      for (const runId of runIds) {
        expect(existsSync(join(home, "runs", `${runId}.ndjson`))).toBe(false);
      }
      const persisted = new DatabaseSync(join(home, "flowpeek.db"))
        .prepare("SELECT COUNT(*) AS count FROM runs WHERE session_id = ?")
        .get("shared-session") as { count: number };
      expect(Number(persisted.count)).toBe(0);
    } finally {
      daemon.kill("SIGTERM");
    }
  });
});

describe("session aggregation", () => {
  it("derives state and treats missing parents as roots", () => {
    const summary = summarizeSession("session-a", [
      run("a", { processState: "exited", status: "exited", endedAt: "2026-08-28T00:00:01.000Z" }),
      run("b", { parentRunId: "a", rootRunId: "a", processState: "running", status: "running" }),
      run("orphan", { parentRunId: "missing", rootRunId: "missing", processState: "unknown", status: "unknown" }),
    ]);
    expect(summary.status).toBe("running");
    expect(summary.runningCount).toBe(1);
    expect(summary.rootCount).toBe(2);
    expect(summary.runCount).toBe(3);
  });

  it("degrades cyclic parent links to independent roots", () => {
    const summary = summarizeSession("session-a", [
      run("cycle-a", { parentRunId: "cycle-b", rootRunId: "cycle-a" }),
      run("cycle-b", { parentRunId: "cycle-a", rootRunId: "cycle-b" }),
    ]);
    expect(summary.rootCount).toBe(2);
  });
});

describe("v0.1 database migration", () => {
  afterEach(() => {
    closeDb();
    if (originalFlowpeekHome == null) delete process.env.FLOWPEEK_HOME;
    else process.env.FLOWPEEK_HOME = originalFlowpeekHome;
  });

  it("adds context columns once and backfills legacy runs", () => {
    const home = makeHome();
    process.env.FLOWPEEK_HOME = home;
    const legacy = new DatabaseSync(join(home, "flowpeek.db"));
    legacy.exec(`
      CREATE TABLE runs (
        id TEXT PRIMARY KEY, label TEXT, command_json TEXT NOT NULL, cwd TEXT NOT NULL,
        started_at TEXT NOT NULL, ended_at TEXT, status TEXT NOT NULL, exit_code INTEGER,
        signal TEXT, adapter_id TEXT, adapter_source TEXT, pty INTEGER NOT NULL DEFAULT 1,
        agent_output TEXT NOT NULL DEFAULT 'passthrough', pid INTEGER, pgid INTEGER,
        dropped_raw_chunks INTEGER NOT NULL DEFAULT 0, dropped_raw_bytes INTEGER NOT NULL DEFAULT 0,
        telemetry_connected INTEGER NOT NULL DEFAULT 1, telemetry_disconnected_at TEXT,
        process_state TEXT NOT NULL DEFAULT 'running', extra_json TEXT
      );
      INSERT INTO runs (id, command_json, cwd, started_at, status, process_state)
      VALUES ('legacy-run', '["echo","ok"]', '/tmp', '2026-08-28T00:00:00.000Z', 'exited', 'exited');
    `);
    legacy.close();

    getDb();
    closeDb();
    getDb();
    const migrated = getRun("legacy-run");
    expect(migrated?.sessionId).toBe("legacy-run");
    expect(migrated?.rootRunId).toBe("legacy-run");
    expect(migrated?.parentRunId).toBeUndefined();
  });

  it("registry returns all roots in one explicit session", () => {
    const home = makeHome();
    process.env.FLOWPEEK_HOME = home;
    const registry = new RunRegistry(DEFAULT_CONFIG);
    const first = run("first", { status: "running", processState: "running" });
    const second = run("second", { startedAt: "2026-08-28T00:00:02.000Z", agentName: "Codex", status: "running", processState: "running" });
    registry.startRun(first, home);
    registry.startRun(second, home);
    const payload = registry.getSession("session-a");
    expect(payload?.session.rootCount).toBe(2);
    expect(payload?.session.agentName).toBe("Codex");
    expect(payload?.runs.map((item) => item.id)).toEqual(["first", "second"]);
    for (const live of registry.live.values()) live.adapter?.dispose();
  });

  it("accepts a legacy v0.1 wrapper record as a one-run session", () => {
    const home = makeHome();
    process.env.FLOWPEEK_HOME = home;
    const registry = new RunRegistry(DEFAULT_CONFIG);
    const legacy = run("legacy-wrapper") as RunRecord & { sessionId?: string; rootRunId?: string };
    delete legacy.sessionId;
    delete legacy.rootRunId;
    const live = registry.startRun(legacy as RunRecord, home);
    expect(live.run.sessionId).toBe("legacy-wrapper");
    expect(live.run.rootRunId).toBe("legacy-wrapper");
    live.adapter?.dispose();
  });
});
