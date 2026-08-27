import { nowIso } from "../ids.js";
import type { RunEvent } from "../types.js";
import type { EmitFn } from "./yaml-engine.js";
import { stripAnsi } from "./yaml-engine.js";

const WARN_RE = /(?:^|\b)(?:warning|warn)[:\s]/i;
const ERR_RE = /(?:^|\b)(?:error|fatal|panic)[:\s]|\bnpm ERR!|\bFAILED\b/;

export interface GenericState {
  bytes: number;
  started: number;
  lastActivity: number;
  window: Array<{ t: number; n: number }>;
  lastRateEmit: number;
  lastHb: number;
}

export function newGenericState(): GenericState {
  const t = Date.now();
  return { bytes: 0, started: t, lastActivity: t, window: [], lastRateEmit: 0, lastHb: 0 };
}

export function genericOnChunk(state: GenericState, chunk: string, emit: EmitFn): void {
  const n = Buffer.byteLength(chunk);
  const t = Date.now();
  state.bytes += n;
  state.lastActivity = t;
  state.window.push({ t, n });
  const cutoff = t - 5000;
  state.window = state.window.filter((w) => w.t >= cutoff);
  if (t - state.lastRateEmit > 2000) {
    const sum = state.window.reduce((s, w) => s + w.n, 0);
    const dt = Math.max(0.5, (t - (state.window[0]?.t || t)) / 1000);
    emit({
      type: "metric",
      metric: { name: "output_bps", value: Math.round(sum / dt), unit: "B/s" },
    });
    emit({
      type: "metric",
      metric: { name: "bytes", value: state.bytes, unit: "B" },
    });
    state.lastRateEmit = t;
  }
}

export function genericOnLine(state: GenericState, line: string, emit: EmitFn): void {
  void state;
  const t = stripAnsi(line).trim();
  if (!t) return;
  if (ERR_RE.test(t)) emit({ type: "error", message: t.slice(0, 240) });
  else if (WARN_RE.test(t)) emit({ type: "warning", message: t.slice(0, 240) });
}

export function genericHeartbeat(state: GenericState, emit: EmitFn): void {
  const t = Date.now();
  if (t - state.lastHb < 5000) return;
  state.lastHb = t;
  emit({
    type: "heartbeat",
    message: `elapsed ${Math.round((t - state.started) / 1000)}s, last activity ${Math.round((t - state.lastActivity) / 1000)}s ago`,
    progress: { kind: "heartbeat", message: "alive" },
  });
}

export function genericOnStart(emit: EmitFn): void {
  emit({ type: "phase", phase: "running", message: "started" });
}

export function genericOnExit(code: number | null, signal: string | null, emit: EmitFn): void {
  emit({
    type: "phase",
    phase: "exited",
    message: signal ? `signal ${signal}` : `exit ${code ?? 0}`,
  });
}

export function elapsedEvent(started: number): Omit<RunEvent, "runId" | "seq"> {
  return {
    ts: nowIso(),
    type: "metric",
    metric: { name: "elapsed_s", value: Math.round((Date.now() - started) / 1000), unit: "s" },
  };
}
