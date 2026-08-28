import { basename } from "node:path";
import type { ProgressPayload, RunRecord, SessionSummary } from "../types.js";
import { sanitizeInline } from "./terminal-buffer.js";
import { buildTreeRows, type TuiTreeRow } from "./tree.js";

export interface TuiLatest {
  phase?: string;
  progress?: ProgressPayload;
  metrics?: Record<string, { value: number; unit?: string }>;
  warnings?: string[];
  errors?: string[];
}

export interface TuiFrameModel {
  view: "sessions" | "session";
  baseUrl: string;
  connected: boolean;
  uptime?: number;
  sessions: SessionSummary[];
  selectedSessionId?: string;
  session?: SessionSummary;
  runs: RunRecord[];
  selectedRunId?: string;
  latest?: TuiLatest;
  outputLines: string[];
  notice?: string;
  now?: number;
}

export interface TuiRenderOptions {
  width: number;
  height: number;
  color: boolean;
  interactive?: boolean;
}

export type TuiMouseAction =
  | { type: "open-session"; id: string }
  | { type: "select-run"; id: string }
  | { type: "back" }
  | { type: "refresh" }
  | { type: "quit" };

export interface TuiHitTarget {
  row: number;
  colStart: number;
  colEnd: number;
  action: TuiMouseAction;
}

export interface TuiLayout {
  frame: string;
  hits: TuiHitTarget[];
}

interface LayoutDraft {
  lines: string[];
  hits: TuiHitTarget[];
}

const ANSI = /\x1b\[[0-9;]*m/g;
const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
};

export function renderTuiFrame(model: TuiFrameModel, options: TuiRenderOptions): string {
  return renderTuiLayout(model, options).frame;
}

export function renderTuiLayout(model: TuiFrameModel, options: TuiRenderOptions): TuiLayout {
  const width = Math.max(24, Math.floor(options.width));
  const height = Math.max(6, Math.floor(options.height));
  const paint = (code: string, text: string): string => options.color ? code + text + C.reset : text;
  const interactive = options.interactive !== false;
  const draft = model.view === "sessions"
    ? renderSessions(model, width, height, paint, interactive)
    : renderSession(model, width, height, paint, interactive);
  return {
    frame: draft.lines.slice(0, height).map((line) => clipAnsi(line, width)).join("\n"),
    hits: interactive
      ? draft.hits
          .filter((hit) => hit.row <= height && hit.colStart <= width)
          .map((hit) => ({ ...hit, colEnd: Math.min(width, hit.colEnd) }))
      : [],
  };
}

function renderHeader(
  model: TuiFrameModel,
  width: number,
  paint: (code: string, text: string) => string,
): string[] {
  const state = model.connected ? paint(C.green, "● CONNECTED") : paint(C.red, "○ OFFLINE");
  const uptime = model.uptime == null ? "" : `  up ${formatDuration(model.uptime * 1000)}`;
  const title = `${paint(C.bold, "FLOWPEEK")}  ${paint(C.dim, "TUI")}  ${state}${paint(C.dim, uptime)}`;
  return [title, paint(C.dim, "─".repeat(width))];
}

function renderSessions(
  model: TuiFrameModel,
  width: number,
  height: number,
  paint: (code: string, text: string) => string,
  interactive: boolean,
): LayoutDraft {
  const lines = renderHeader(model, width, paint);
  const hits: TuiHitTarget[] = [];
  lines.push(`${paint(C.bold, "ACTIVE SESSIONS")}  ${paint(C.dim, String(model.sessions.length))}`);

  if (!model.sessions.length) {
    lines.push("");
    lines.push(paint(C.dim, model.connected ? "Nothing to watch." : "Collector is unreachable."));
    lines.push(paint(C.dim, "Waiting for flowpeek run …"));
  } else {
    const available = Math.max(1, height - 5);
    const selected = Math.max(0, model.sessions.findIndex((session) => session.id === model.selectedSessionId));
    const visible = windowed(model.sessions, selected, available);
    for (const session of visible.items) {
      const active = session.id === model.selectedSessionId;
      const dot = statusDot(session.status, paint);
      const title = sessionTitle(session);
      const stats = `${session.runningCount}/${session.runCount} running  ${elapsed(session.startedAt, undefined, model.now)}`;
      const lead = active ? paint(C.cyan, "›") : " ";
      const nameWidth = Math.max(8, width - visibleLength(stats) - 8);
      lines.push(`${lead} ${dot} ${active ? paint(C.bold, fitPlain(title, nameWidth)) : fitPlain(title, nameWidth)}  ${paint(C.dim, stats)}`);
      hits.push({ row: lines.length, colStart: 1, colEnd: width, action: { type: "open-session", id: session.id } });
    }
  }

  if (model.notice) lines.push(paint(C.yellow, `! ${sanitizeInline(model.notice)}`));
  const footer = interactive
    ? "[Quit]  [Refresh]   click session · wheel navigate"
    : "plain-text snapshot · active runs only";
  if (interactive) {
    addFooterHits(hits, footer, height, [
      ["[Refresh]", { type: "refresh" }],
      ["[Quit]", { type: "quit" }],
    ]);
  }
  return { lines: finish(lines, height, paint(C.dim, footer)), hits };
}

function renderSession(
  model: TuiFrameModel,
  width: number,
  height: number,
  paint: (code: string, text: string) => string,
  interactive: boolean,
): LayoutDraft {
  const lines = renderHeader(model, width, paint);
  const hits: TuiHitTarget[] = [];
  const session = model.session;
  const title = session ? sessionTitle(session) : sanitizeInline(model.selectedSessionId || "Session");
  const state = session ? `${session.runningCount}/${session.runCount} running` : "not found";
  lines.push(`${paint(C.bold, title)}  ${paint(C.dim, state)}`);

  const treeRows = buildTreeRows(model.runs);
  lines.push(paint(C.dim, "RUNS"));
  if (!treeRows.length) {
    lines.push(paint(C.dim, "  No active runs."));
  } else {
    const selected = Math.max(0, treeRows.findIndex((row) => row.run.id === model.selectedRunId));
    const treeHeight = Math.max(1, Math.min(treeRows.length, Math.floor((height - 9) / 3) + 1, 7));
    const visible = windowed(treeRows, selected, treeHeight);
    for (const row of visible.items) {
      lines.push(renderRunRow(row, row.run.id === model.selectedRunId, width, model.now, paint));
      hits.push({ row: lines.length, colStart: 1, colEnd: width, action: { type: "select-run", id: row.run.id } });
    }
  }

  const run = model.runs.find((item) => item.id === model.selectedRunId);
  if (run) {
    const detail = [
      `phase ${sanitizeInline(model.latest?.phase || run.processState)}`,
      `adapter ${sanitizeInline(run.adapterId || "generic")}`,
      `elapsed ${elapsed(run.startedAt, run.endedAt, model.now)}`,
      run.droppedRawChunks ? `dropped ${run.droppedRawChunks}` : "",
    ].filter(Boolean).join("  ·  ");
    lines.push(paint(C.dim, detail));
    const progress = renderProgress(model.latest?.progress, width, paint);
    if (progress) lines.push(progress);
  }

  const footerReserve = 1;
  const noticeReserve = model.notice ? 1 : 0;
  const remaining = Math.max(1, height - lines.length - footerReserve - noticeReserve - 1);
  lines.push(`${paint(C.dim, "OUTPUT")}  ${paint(C.dim, run ? "following" : "—")}`);
  const output = model.outputLines.slice(-remaining);
  if (output.length) {
    for (const line of output) lines.push(`  ${sanitizeInline(line)}`);
  } else {
    lines.push(paint(C.dim, "  Waiting for output …"));
  }
  if (model.notice) lines.push(paint(C.yellow, `! ${sanitizeInline(model.notice)}`));
  const footer = interactive
    ? "[Back]  [Quit]  [Refresh]   click run · wheel navigate"
    : "plain-text snapshot · active runs only";
  if (interactive) {
    addFooterHits(hits, footer, height, [
      ["[Back]", { type: "back" }],
      ["[Quit]", { type: "quit" }],
      ["[Refresh]", { type: "refresh" }],
    ]);
  }
  return { lines: finish(lines, height, paint(C.dim, footer)), hits };
}

function renderRunRow(
  row: TuiTreeRow,
  selected: boolean,
  width: number,
  now: number | undefined,
  paint: (code: string, text: string) => string,
): string {
  const run = row.run;
  const lead = selected ? paint(C.cyan, "›") : " ";
  const dot = statusDot(run.processState, paint);
  const duration = elapsed(run.startedAt, run.endedAt, now);
  const prefix = row.prefix;
  const titleWidth = Math.max(8, width - visibleLength(prefix) - visibleLength(duration) - 8);
  const title = fitPlain(sanitizeInline(run.label || run.command.join(" ") || run.id), titleWidth);
  return `${lead} ${prefix}${dot} ${selected ? paint(C.bold, title) : title}  ${paint(C.dim, duration)}`;
}

function renderProgress(
  progress: ProgressPayload | undefined,
  width: number,
  paint: (code: string, text: string) => string,
): string | undefined {
  if (!progress) return undefined;
  const message = sanitizeInline(progress.message || "");
  if (progress.kind !== "determinate" || !progress.total) {
    return paint(C.dim, `progress ${message || progress.kind}`);
  }
  const percent = Math.max(0, Math.min(100, progress.percent ?? ((progress.current || 0) / progress.total) * 100));
  const label = `${progress.current ?? 0}/${progress.total}  ${Math.round(percent)}%`;
  const barWidth = Math.max(8, Math.min(36, width - visibleLength(label) - 12));
  const filled = Math.round((barWidth * percent) / 100);
  const bar = paint(C.cyan, "█".repeat(filled)) + paint(C.dim, "░".repeat(barWidth - filled));
  return `${bar}  ${label}${message && !message.includes(`${progress.current}/${progress.total}`) ? `  ${message}` : ""}`;
}

function sessionTitle(session: SessionSummary): string {
  return sanitizeInline(session.agentName || basename(session.cwd || "") || session.id || "Session");
}

function statusDot(
  status: RunRecord["processState"] | SessionSummary["status"],
  paint: (code: string, text: string) => string,
): string {
  if (status === "running") return paint(C.green, "●");
  if (status === "unknown") return paint(C.yellow, "●");
  return paint(C.dim, "○");
}

function elapsed(startedAt: string, endedAt?: string, now = Date.now()): string {
  const start = Date.parse(startedAt);
  const end = endedAt ? Date.parse(endedAt) : now;
  return formatDuration(Math.max(0, end - start));
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function finish(lines: string[], height: number, footer: string): string[] {
  const kept = lines.slice(0, Math.max(0, height - 1));
  while (kept.length < height - 1) kept.push("");
  kept.push(footer);
  return kept;
}

function addFooterHits(
  hits: TuiHitTarget[],
  footer: string,
  row: number,
  entries: Array<[string, TuiMouseAction]>,
): void {
  for (const [label, action] of entries) {
    const index = footer.indexOf(label);
    if (index >= 0) hits.push({ row, colStart: index + 1, colEnd: index + label.length, action });
  }
}

function windowed<T>(items: T[], selected: number, limit: number): { items: T[]; start: number } {
  if (items.length <= limit) return { items, start: 0 };
  const start = Math.max(0, Math.min(items.length - limit, selected - Math.floor(limit / 2)));
  return { items: items.slice(start, start + limit), start };
}

function fitPlain(text: string, width: number): string {
  const clean = sanitizeInline(text);
  if (width <= 0) return "";
  if ([...clean].length <= width) return clean.padEnd(width);
  if (width === 1) return "…";
  return [...clean].slice(0, width - 1).join("") + "…";
}

function visibleLength(text: string): number {
  return [...text.replace(ANSI, "")].length;
}

function clipAnsi(text: string, width: number): string {
  if (visibleLength(text) <= width) return text;
  let out = "";
  let visible = 0;
  let index = 0;
  const target = Math.max(0, width - 1);
  while (index < text.length && visible < target) {
    if (text[index] === "\x1b") {
      const match = text.slice(index).match(/^\x1b\[[0-9;]*m/);
      if (match) {
        out += match[0];
        index += match[0].length;
        continue;
      }
    }
    const codePoint = text.codePointAt(index);
    if (codePoint == null) break;
    const char = String.fromCodePoint(codePoint);
    out += char;
    index += char.length;
    visible++;
  }
  return out + "…" + (text.includes("\x1b[") ? C.reset : "");
}
