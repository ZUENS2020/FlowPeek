import { describe, expect, it } from "vitest";
import type { RunRecord, SessionSummary } from "../src/types.js";
import { renderTuiFrame, renderTuiLayout } from "../src/tui/render.js";
import { DISABLE_MOUSE, ENABLE_MOUSE, parseSgrMouse } from "../src/tui/mouse.js";
import { TerminalBuffer } from "../src/tui/terminal-buffer.js";
import { buildTreeRows } from "../src/tui/tree.js";
import { collect, freePort, makeHome, spawnCli, startDaemon } from "./helpers.js";

function run(id: string, patch: Partial<RunRecord> = {}): RunRecord {
  return {
    id,
    sessionId: "session-a",
    rootRunId: id,
    command: ["node", "task.js"],
    cwd: "/tmp/project",
    startedAt: "2026-08-28T00:00:00.000Z",
    status: "running",
    processState: "running",
    pty: false,
    agentOutput: "passthrough",
    droppedRawChunks: 0,
    droppedRawBytes: 0,
    telemetryConnected: true,
    ...patch,
  };
}

function session(patch: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: "session-a",
    agentName: "Cursor",
    cwd: "/tmp/project",
    startedAt: "2026-08-28T00:00:00.000Z",
    status: "running",
    runCount: 1,
    rootCount: 1,
    runningCount: 1,
    ...patch,
  };
}

describe("TUI terminal buffer", () => {
  it("applies CR updates and strips split ANSI/control sequences", () => {
    const buffer = new TerminalBuffer();
    buffer.write("\x1b[3");
    buffer.write("1mstep 1\rstep 2\x1b[0m\n");
    buffer.write("\x1b]0;hostile title\x07ok\n");
    expect(buffer.text()).toBe("step 2\nok\n");
    expect(buffer.text()).not.toContain("\x1b");
  });
});

describe("TUI mouse protocol", () => {
  it("parses clicks, releases, and wheel movement from SGR reports", () => {
    const events = parseSgrMouse(
      "\x1b[<0;12;4M\x1b[<0;12;4m\x1b[<64;8;6M\x1b[<65;8;6M",
    );
    expect(events.map((event) => event.kind)).toEqual(["left", "left", "wheel-up", "wheel-down"]);
    expect(events[0]).toMatchObject({ x: 12, y: 4, release: false });
    expect(events[1].release).toBe(true);
    expect(ENABLE_MOUSE).toContain("?1006h");
    expect(DISABLE_MOUSE).toContain("?1006l");
  });
});

describe("TUI run tree", () => {
  it("renders nesting and degrades missing parents and cycles to roots", () => {
    const rows = buildTreeRows([
      run("root"),
      run("child", { parentRunId: "root", rootRunId: "root" }),
      run("orphan", { parentRunId: "missing" }),
      run("cycle-a", { parentRunId: "cycle-b" }),
      run("cycle-b", { parentRunId: "cycle-a" }),
    ]);
    expect(rows.map((row) => row.run.id)).toEqual(["root", "child", "orphan", "cycle-a", "cycle-b"]);
    expect(rows.find((row) => row.run.id === "child")?.prefix).toBe("└─");
    expect(rows.filter((row) => row.depth === 0)).toHaveLength(4);
  });
});

describe("TUI rendering", () => {
  it("renders a bounded session view without replaying observed control codes", () => {
    const frame = renderTuiFrame({
      view: "session",
      baseUrl: "http://127.0.0.1:47831",
      connected: true,
      uptime: 12,
      sessions: [session()],
      selectedSessionId: "session-a",
      session: session(),
      runs: [run("root", { label: "build\x1b[2Jhostile" })],
      selectedRunId: "root",
      latest: {
        phase: "compile",
        progress: { kind: "determinate", current: 4, total: 10 },
      },
      outputLines: ["Compiling core", "4/10"],
      now: Date.parse("2026-08-28T00:00:05.000Z"),
    }, { width: 60, height: 18, color: false });
    expect(frame).toMatch(/FLOWPEEK\s+TUI/);
    expect(frame).toContain("Cursor");
    expect(frame).toContain("4/10");
    expect(frame).toContain("Compiling core");
    expect(frame).not.toContain("\x1b");
    expect(frame.split("\n")).toHaveLength(18);
    expect(frame.split("\n").every((line) => [...line].length <= 60)).toBe(true);
  });

  it("renders the empty live-session state", () => {
    const frame = renderTuiFrame({
      view: "sessions",
      baseUrl: "http://127.0.0.1:47831",
      connected: true,
      sessions: [],
      runs: [],
      outputLines: [],
    }, { width: 50, height: 12, color: false });
    expect(frame).toContain("Nothing to watch");
    expect(frame).not.toMatch(/Recent/i);
  });

  it("exposes clickable session, run, back, refresh, and quit targets", () => {
    const home = renderTuiLayout({
      view: "sessions",
      baseUrl: "http://127.0.0.1:47831",
      connected: true,
      sessions: [session()],
      selectedSessionId: "session-a",
      runs: [],
      outputLines: [],
    }, { width: 80, height: 16, color: false });
    expect(home.hits.some((hit) => hit.action.type === "open-session" && hit.action.id === "session-a")).toBe(true);
    expect(home.hits.some((hit) => hit.action.type === "refresh")).toBe(true);
    expect(home.hits.some((hit) => hit.action.type === "quit")).toBe(true);

    const detail = renderTuiLayout({
      view: "session",
      baseUrl: "http://127.0.0.1:47831",
      connected: true,
      sessions: [session()],
      selectedSessionId: "session-a",
      session: session(),
      runs: [run("root")],
      selectedRunId: "root",
      outputLines: [],
    }, { width: 80, height: 16, color: false });
    expect(detail.hits.some((hit) => hit.action.type === "select-run" && hit.action.id === "root")).toBe(true);
    expect(detail.hits.some((hit) => hit.action.type === "back")).toBe(true);

    const snapshot = renderTuiLayout({
      view: "sessions",
      baseUrl: "http://127.0.0.1:47831",
      connected: true,
      sessions: [session()],
      selectedSessionId: "session-a",
      runs: [],
      outputLines: [],
    }, { width: 80, height: 16, color: false, interactive: false });
    expect(snapshot.hits).toEqual([]);
    expect(snapshot.frame).toContain("plain-text snapshot");
  });
});

describe("TUI CLI", () => {
  it("documents the TUI command and controls", async () => {
    const home = makeHome();
    const port = await freePort();
    const result = await collect(spawnCli(["tui", "--help"], { home, port }));
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/flowpeek tui/);
    expect(result.stdout).toMatch(/--once/);
    expect(result.stdout).toMatch(/--refresh-ms/);
  });

  it("prints one live session snapshot without requiring an interactive TTY", async () => {
    const home = makeHome();
    const port = await freePort();
    const daemon = await startDaemon(home, port);
    try {
      const wrapper = spawnCli([
        "run",
        "--no-dashboard-url",
        "--pty",
        "never",
        "--session",
        "tui-session",
        "--agent",
        "Cursor",
        "--label",
        "TUI demo",
        "--",
        "node",
        "-e",
        "console.log('TUI_STREAM_LINE'); setTimeout(() => {}, 1600)",
      ], { home, port });
      await new Promise((resolve) => setTimeout(resolve, 250));
      const snapshot = await collect(spawnCli([
        "tui",
        "--once",
        "--session",
        "tui-session",
      ], { home, port, env: { COLUMNS: "80", LINES: "22" } }));
      expect(snapshot.code).toBe(0);
      expect(snapshot.stderr).toBe("");
      expect(snapshot.stdout).toContain("FLOWPEEK  TUI");
      expect(snapshot.stdout).toContain("Cursor");
      expect(snapshot.stdout).toContain("TUI demo");
      expect(snapshot.stdout).toContain("TUI_STREAM_LINE");
      expect(snapshot.stdout).not.toContain("\x1b");

      const sessionPayload = await fetch(`http://127.0.0.1:${port}/api/sessions/tui-session`)
        .then((response) => response.json()) as { runs: RunRecord[] };
      const direct = await collect(spawnCli([
        "tui",
        "--once",
        "--run",
        sessionPayload.runs[0].id,
      ], { home, port, env: { COLUMNS: "80", LINES: "22" } }));
      expect(direct.code).toBe(0);
      expect(direct.stdout).toContain("TUI demo");
      expect(direct.stdout).toContain("TUI_STREAM_LINE");
      expect((await collect(wrapper)).code).toBe(0);
    } finally {
      daemon.kill("SIGTERM");
    }
  });

  it("requires a TTY unless --once is supplied", async () => {
    const home = makeHome();
    const port = await freePort();
    const result = await collect(spawnCli(["tui"], { home, port }));
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/interactive terminal/);
  });

  it("rejects incomplete and conflicting direct-view options", async () => {
    const home = makeHome();
    const port = await freePort();
    const missing = await collect(spawnCli(["tui", "--once", "--session"], { home, port }));
    expect(missing.code).toBe(2);
    expect(missing.stderr).toMatch(/--session requires a value/);
    const conflict = await collect(spawnCli([
      "tui", "--once", "--session", "a", "--run", "b",
    ], { home, port }));
    expect(conflict.code).toBe(2);
    expect(conflict.stderr).toMatch(/either --session or --run/);
  });
});
