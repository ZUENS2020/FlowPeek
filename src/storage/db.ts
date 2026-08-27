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
  return db;
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
      id, label, command_json, cwd, started_at, ended_at, status, exit_code, signal,
      adapter_id, adapter_source, pty, agent_output, pid, pgid, dropped_raw_chunks,
      dropped_raw_bytes, telemetry_connected, telemetry_disconnected_at, process_state
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
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

export function listRuns(limit = 200): RunRecord[] {
  const rows = getDb()
    .prepare("SELECT * FROM runs ORDER BY started_at DESC LIMIT ?")
    .all(limit) as Record<string, unknown>[];
  return rows.map(rowToRun);
}

export function deleteRunRow(id: string): void {
  getDb().prepare("DELETE FROM runs WHERE id = ?").run(id);
}

export function listRunIds(): string[] {
  const rows = getDb().prepare("SELECT id FROM runs").all() as { id: string }[];
  return rows.map((r) => r.id);
}
