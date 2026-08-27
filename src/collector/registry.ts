import { EventEmitter } from "node:events";
import type { RunEvent, RunRecord } from "../types.js";
import { nowIso } from "../ids.js";
import { upsertRun, getRun, listRuns } from "../storage/db.js";
import { createLogWriter, readLogEvents, type LogWriter } from "../storage/log-store.js";
import { AdapterSession } from "../adapters/engine.js";
import { resolveAdapter } from "../adapters/resolve.js";
import type { AppConfig } from "../types.js";

export interface LiveRun {
  run: RunRecord;
  writer: LogWriter;
  adapter: AdapterSession | null;
  seq: number;
  lastSeen: number;
  structured: RunEvent[];
  rawRing: RunEvent[];
  subscribers: Set<(ev: RunEvent) => void>;
  latest: {
    phase?: string;
    progress?: RunEvent["progress"];
    metrics: Record<string, { value: number; unit?: string }>;
    warnings: string[];
    errors: string[];
  };
}

const RAW_RING = 4000;
const STRUCT_RING = 500;

function absorbLatest(live: LiveRun, ev: RunEvent): void {
  const L = live.latest;
  if (ev.type === "phase" && ev.phase) L.phase = ev.phase;
  if (ev.type === "progress" && ev.progress) L.progress = ev.progress;
  if (ev.type === "metric" && ev.metric) {
    L.metrics[ev.metric.name] = { value: ev.metric.value, unit: ev.metric.unit };
  }
  if (ev.type === "warning" && ev.message) {
    L.warnings.push(ev.message);
    if (L.warnings.length > 20) L.warnings.shift();
  }
  if (ev.type === "error" && ev.message) {
    L.errors.push(ev.message);
    if (L.errors.length > 20) L.errors.shift();
  }
}

export class RunRegistry extends EventEmitter {
  readonly live = new Map<string, LiveRun>();
  constructor(private readonly cfg: AppConfig) {
    super();
  }

  liveIds(): Set<string> {
    return new Set(this.live.keys());
  }

  startRun(run: RunRecord, project: string): LiveRun {
    run.telemetryConnected = true;
    upsertRun(run);
    const maxBytes = this.cfg.storage.max_run_mb * 1024 * 1024;
    const writer = createLogWriter(run.id, maxBytes);
    const live: LiveRun = {
      run,
      writer,
      adapter: null,
      seq: 0,
      lastSeen: Date.now(),
      structured: [],
      rawRing: [],
      subscribers: new Set(),
      latest: { metrics: {}, warnings: [], errors: [] },
    };
    this.live.set(run.id, live);

    const requested = run.adapterId || "auto";
    if (requested !== "none") {
      const resolved = resolveAdapter(run.command, run.cwd, project, requested as "auto" | "none" | string);
      run.adapterId = resolved.spec.id;
      run.adapterSource = resolved.source;
      upsertRun(run);
      live.adapter = new AdapterSession(
        run.id,
        resolved,
        (ev) => this.publishStructured(live, ev),
        (reason) => {
          this.publishStructured(live, {
            runId: run.id,
            seq: 0,
            ts: nowIso(),
            type: "warning",
            message: `adapter disabled: ${reason}`,
          });
          this.emit("downlink", run.id, { t: "adapter-fail", id: run.id, message: reason });
        },
      );
    }
    this.emit("update", run);
    return live;
  }

  ingestRaw(id: string, b64: string, byteLength: number, seqHint?: number): void {
    const live = this.live.get(id);
    if (!live) return;
    this.markTelemetryRestored(id);
    live.seq = Math.max(live.seq + 1, seqHint || 0);
    const ev: RunEvent = {
      runId: id,
      seq: live.seq,
      ts: nowIso(),
      type: "raw",
      b64,
      byteLength,
    };
    live.writer.append(ev);
    live.rawRing.push(ev);
    if (live.rawRing.length > RAW_RING) live.rawRing.splice(0, live.rawRing.length - RAW_RING);
    this.broadcast(live, ev);
    let text = "";
    try {
      text = Buffer.from(b64, "base64").toString("utf8");
    } catch {
      return;
    }
    // Adapter is fail-open: errors disable adapter, never the child.
    void live.adapter?.onChunk(text).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      live.adapter?.dispose();
      live.adapter = null;
      this.publishStructured(live, {
        runId: id,
        seq: 0,
        ts: nowIso(),
        type: "warning",
        message: `adapter crashed: ${msg}; raw log continues`,
      });
    });
  }

  publishStructured(live: LiveRun, ev: RunEvent): void {
    live.seq += 1;
    ev.seq = live.seq;
    if (!ev.ts) ev.ts = nowIso();
    live.writer.append(ev);
    live.structured.push(ev);
    if (live.structured.length > STRUCT_RING) live.structured.splice(0, live.structured.length - STRUCT_RING);
    absorbLatest(live, ev);
    this.broadcast(live, ev);
    this.emit("downlink", live.run.id, { t: "evt", id: live.run.id, event: ev });
    this.emit("update", live.run);
  }

  markDropped(id: string, dropped: number): void {
    const live = this.live.get(id);
    if (!live) return;
    live.run.droppedRawChunks = dropped;
    upsertRun(live.run);
    this.publishStructured(live, {
      runId: id,
      seq: 0,
      ts: nowIso(),
      type: "heartbeat",
      dropped,
      message: `telemetry dropped ${dropped} raw chunks (collector backpressure; process unaffected)`,
    });
  }

  heartbeat(id: string, dropped: number): void {
    const live = this.live.get(id);
    if (!live) return;
    this.markTelemetryRestored(id);
    live.run.droppedRawChunks = dropped;
    this.broadcast(live, {
      runId: id,
      seq: live.seq,
      ts: nowIso(),
      type: "heartbeat",
      dropped,
      message: "wrapper heartbeat",
    });
  }

  exit(id: string, code: number | null, signal: string | null, endedAt: string): void {
    const live = this.live.get(id);
    if (!live) return;
    live.run.status = "exited";
    live.run.processState = "exited";
    live.run.exitCode = code;
    live.run.signal = signal;
    live.run.endedAt = endedAt;
    upsertRun(live.run);
    void live.adapter?.onExit(code, signal);
    this.publishStructured(live, {
      runId: id,
      seq: 0,
      ts: endedAt,
      type: "exit",
      exitCode: code,
      signal,
    });
    // Keep live subscribers briefly, then archive.
    setTimeout(() => {
      live.adapter?.dispose();
      this.live.delete(id);
    }, 15_000).unref?.();
    this.emit("update", live.run);
  }

  markTelemetryLost(id: string): void {
    const live = this.live.get(id);
    if (!live) return;
    live.run.telemetryConnected = false;
    live.run.telemetryDisconnectedAt = nowIso();
    // Do NOT mark process as failed — only telemetry is gone.
    if (live.run.processState === "running") live.run.processState = "unknown";
    live.run.status = live.run.status === "exited" ? "exited" : "unknown";
    upsertRun(live.run);
    this.publishStructured(live, {
      runId: id,
      seq: 0,
      ts: nowIso(),
      type: "warning",
      message: "telemetry connection lost (process state unknown; not marked failed)",
    });
    this.emit("update", live.run);
  }

  /**
   * Wrapper reconnected (hello / heartbeat / raw). Restore running state when
   * the process has not already exited — disconnect is not a process failure.
   */
  markTelemetryRestored(id: string): void {
    const live = this.live.get(id);
    if (!live) return;
    live.lastSeen = Date.now();
    const exited = live.run.processState === "exited" || live.run.status === "exited";
    const wasLost = !live.run.telemetryConnected || live.run.processState === "unknown";
    live.run.telemetryConnected = true;
    if (!exited) {
      live.run.processState = "running";
      live.run.status = "running";
      live.run.telemetryDisconnectedAt = undefined;
    }
    if (wasLost && !exited) {
      upsertRun(live.run);
      this.emit("update", live.run);
    }
  }

  subscribe(id: string, cb: (ev: RunEvent) => void): () => void {
    const live = this.live.get(id);
    if (live) {
      live.subscribers.add(cb);
      return () => live.subscribers.delete(cb);
    }
    return () => undefined;
  }

  snapshot(id: string): { run: RunRecord; events: RunEvent[]; live: boolean } | undefined {
    const live = this.live.get(id);
    if (live) {
      return {
        run: live.run,
        events: [...live.rawRing.slice(-200), ...live.structured.slice(-200)].sort((a, b) => a.seq - b.seq),
        live: true,
      };
    }
    const run = getRun(id);
    if (!run) return undefined;
    return { run, events: readLogEvents(id, 0, 2000), live: false };
  }

  list(): RunRecord[] {
    const fromDb = listRuns(200);
    const map = new Map(fromDb.map((r) => [r.id, r]));
    for (const l of this.live.values()) map.set(l.run.id, l.run);
    return [...map.values()].sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
  }

  private broadcast(live: LiveRun, ev: RunEvent): void {
    for (const cb of live.subscribers) {
      try {
        cb(ev);
      } catch {
        /* subscriber failure must not affect ingest */
      }
    }
  }

  checkStale(ms = 8000): void {
    const now = Date.now();
    for (const live of this.live.values()) {
      if (live.run.processState === "running" && live.run.telemetryConnected && now - live.lastSeen > ms) {
        this.markTelemetryLost(live.run.id);
      }
    }
  }
}
