import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { RunRecord } from "../types.js";
import { dbPath, ensureHome } from "../paths.js";

let db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (db) return db;
  ensureHome();
  mkdirSync(dirname(dbPath()), { recursive: true });
  db = new DatabaseSync(dbPath());
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      parent_run_id TEXT,
      root_run_id TEXT,
      agent_name TEXT,
      label TEXT,
      command_json TEXT NOT NULL,
      cwd TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      status TEXT NOT NULL,
      exit_code INTEGER,
      signal TEXT,
      adapter_id TEXT,
      adapter_source TEXT,
      pty INTEGER NOT NULL DEFAULT 1,
      agent_output TEXT NOT NULL DEFAULT 'passthrough',
      pid INTEGER,
      pgid INTEGER,
      dropped_raw_chunks INTEGER NOT NULL DEFAULT 0,
      dropped_raw_bytes INTEGER NOT NULL DEFAULT 0,
      telemetry_connected INTEGER NOT NULL DEFAULT 1,
      telemetry_disconnected_at TEXT,
      process_state TEXT NOT NULL DEFAULT 'running',
      extra_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_runs_started ON runs(started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
  `);
  migrateRunContext(db);
  return db;
}

function migrateRunContext(database: DatabaseSync): void {
  const rows = database.prepare("PRAGMA table_info(runs)").all() as { name: string }[];
  const columns = new Set(rows.map((row) => row.name));
  const additions: Array<[string, string]> = [
    ["session_id", "TEXT"],
    ["parent_run_id", "TEXT"],
    ["root_run_id", "TEXT"],
    ["agent_name", "TEXT"],
  ];
  for (const [name, type] of additions) {
    if (!columns.has(name)) database.exec(`ALTER TABLE runs ADD COLUMN ${name} ${type}`);
  }
  database.exec(`
    UPDATE runs SET session_id = id WHERE session_id IS NULL OR session_id = '';
    UPDATE runs SET root_run_id = id WHERE root_run_id IS NULL OR root_run_id = '';
    CREATE INDEX IF NOT EXISTS idx_runs_session ON runs(session_id, started_at);
    CREATE INDEX IF NOT EXISTS idx_runs_parent ON runs(parent_run_id);
  `);
}

export function closeDb(): void {
  try {
    db?.close();
  } catch {
    /* ignore */
  }
  db = null;
}

function rowToRun(row: Record<string, unknown>): RunRecord {
  return {
    id: String(row.id),
    sessionId: row.session_id ? String(row.session_id) : String(row.id),
    parentRunId: row.parent_run_id ? String(row.parent_run_id) : undefined,
    rootRunId: row.root_run_id ? String(row.root_run_id) : String(row.id),
    agentName: row.agent_name ? String(row.agent_name) : undefined,
    label: row.label ? String(row.label) : undefined,
    command: JSON.parse(String(row.command_json)),
    cwd: String(row.cwd),
    startedAt: String(row.started_at),
    endedAt: row.ended_at ? String(row.ended_at) : undefined,
    status: row.status as RunRecord["status"],
    exitCode: row.exit_code == null ? undefined : Number(row.exit_code),
    signal: row.signal ? String(row.signal) : null,
    adapterId: row.adapter_id ? String(row.adapter_id) : undefined,
    adapterSource: row.adapter_source ? String(row.adapter_source) : undefined,
    pty: Boolean(row.pty),
    agentOutput: (row.agent_output as RunRecord["agentOutput"]) || "passthrough",
    pid: row.pid == null ? undefined : Number(row.pid),
    pgid: row.pgid == null ? undefined : Number(row.pgid),
    droppedRawChunks: Number(row.dropped_raw_chunks || 0),
    droppedRawBytes: Number(row.dropped_raw_bytes || 0),
    telemetryConnected: Boolean(row.telemetry_connected),
    telemetryDisconnectedAt: row.telemetry_disconnected_at
      ? String(row.telemetry_disconnected_at)
      : undefined,
    processState: (row.process_state as RunRecord["processState"]) || "running",
  };
}

export function upsertRun(run: RunRecord): void {
  const d = getDb();
  d.prepare(
    `INSERT INTO runs (
      id, session_id, parent_run_id, root_run_id, agent_name,
      label, command_json, cwd, started_at, ended_at, status, exit_code, signal,
      adapter_id, adapter_source, pty, agent_output, pid, pgid, dropped_raw_chunks,
      dropped_raw_bytes, telemetry_connected, telemetry_disconnected_at, process_state
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      session_id=excluded.session_id,
      parent_run_id=excluded.parent_run_id,
      root_run_id=excluded.root_run_id,
      agent_name=excluded.agent_name,
      label=excluded.label,
      ended_at=excluded.ended_at,
      status=excluded.status,
      exit_code=excluded.exit_code,
      signal=excluded.signal,
      adapter_id=excluded.adapter_id,
      adapter_source=excluded.adapter_source,
      pid=excluded.pid,
      pgid=excluded.pgid,
      dropped_raw_chunks=excluded.dropped_raw_chunks,
      dropped_raw_bytes=excluded.dropped_raw_bytes,
      telemetry_connected=excluded.telemetry_connected,
      telemetry_disconnected_at=excluded.telemetry_disconnected_at,
      process_state=excluded.process_state
    `,
  ).run(
    run.id,
    run.sessionId,
    run.parentRunId ?? null,
    run.rootRunId,
    run.agentName ?? null,
    run.label ?? null,
    JSON.stringify(run.command),
    run.cwd,
    run.startedAt,
    run.endedAt ?? null,
    run.status,
    run.exitCode ?? null,
    run.signal ?? null,
    run.adapterId ?? null,
    run.adapterSource ?? null,
    run.pty ? 1 : 0,
    run.agentOutput,
    run.pid ?? null,
    run.pgid ?? null,
    run.droppedRawChunks,
    run.droppedRawBytes,
    run.telemetryConnected ? 1 : 0,
    run.telemetryDisconnectedAt ?? null,
    run.processState,
  );
}

export function getRun(id: string): RunRecord | undefined {
  const row = getDb().prepare("SELECT * FROM runs WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToRun(row) : undefined;
}

export function deleteRunRow(id: string): void {
  getDb().prepare("DELETE FROM runs WHERE id = ?").run(id);
}

/**
 * Remove active rows left behind by a daemon crash. Exited rows may belong to
 * an older FlowPeek version, so upgrading to ephemeral history never deletes
 * them without an explicit user action.
 */
export function purgeInterruptedRunRows(): string[] {
  const d = getDb();
  const rows = d
    .prepare("SELECT id FROM runs WHERE status != 'exited' OR process_state != 'exited'")
    .all() as { id: string }[];
  d.prepare("DELETE FROM runs WHERE status != 'exited' OR process_state != 'exited'").run();
  return rows.map((row) => row.id);
}
