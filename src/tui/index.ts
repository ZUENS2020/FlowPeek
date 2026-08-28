import { loadConfig } from "../config.js";
import { dashboardUrl, isLoopback } from "../paths.js";
import type { RunEvent, RunRecord, SessionSummary } from "../types.js";
import { ensureDaemon } from "../wrapper/ensure-daemon.js";
import {
  renderTuiLayout,
  type TuiFrameModel,
  type TuiHitTarget,
  type TuiLatest,
  type TuiMouseAction,
} from "./render.js";
import { DISABLE_MOUSE, ENABLE_MOUSE, parseSgrMouse, type TuiMouseEvent } from "./mouse.js";
import { TerminalBuffer } from "./terminal-buffer.js";
import { buildTreeRows } from "./tree.js";

export interface TuiOptions {
  sessionId?: string;
  runId?: string;
  project?: string;
  refreshMs?: number;
  once?: boolean;
  noColor?: boolean;
}

interface HealthResponse {
  ok: boolean;
  uptime: number;
}

interface SessionsResponse {
  sessions: SessionSummary[];
}

interface SessionResponse {
  session: SessionSummary;
  runs: RunRecord[];
}

interface RunResponse {
  run: RunRecord;
  latest?: TuiLatest;
}

interface EventsResponse {
  events: RunEvent[];
}

interface RunStreamState {
  buffer: TerminalBuffer;
  decoder: TextDecoder;
  lastSeq: number;
}

class HttpStatusError extends Error {
  constructor(readonly status: number, path: string) {
    super(`${path}: HTTP ${status}`);
  }
}

class TuiController {
  private view: "sessions" | "session";
  private connected = false;
  private uptime?: number;
  private sessions: SessionSummary[] = [];
  private selectedSessionId?: string;
  private session?: SessionSummary;
  private runs: RunRecord[] = [];
  private selectedRunId?: string;
  private latest?: TuiLatest;
  private notice?: string;
  private readonly streams = new Map<string, RunStreamState>();
  private stopped = false;
  private timer?: NodeJS.Timeout;
  private refreshing = false;
  private finishCode = 0;
  private hitTargets: TuiHitTarget[] = [];

  constructor(
    private readonly baseUrl: string,
    private readonly options: TuiOptions,
  ) {
    this.view = options.sessionId || options.runId ? "session" : "sessions";
    this.selectedSessionId = options.sessionId;
    this.selectedRunId = options.runId;
  }

  async refresh(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      await this.refreshHealthAndSessions();
      if (this.options.runId && !this.selectedSessionId) {
        try {
          const detail = await this.getJson<RunResponse>(`/api/runs/${encodeURIComponent(this.options.runId)}`);
          this.selectedSessionId = detail.run.sessionId;
          this.selectedRunId = detail.run.id;
          this.latest = detail.latest;
        } catch (err) {
          this.notice = errorMessage(err, `Run ${this.options.runId} is not active.`);
        }
      }
      if (this.view === "session" && this.selectedSessionId) await this.refreshSession();
    } finally {
      this.refreshing = false;
    }
  }

  frame(width: number, height: number, color: boolean, interactive = true): string {
    const stream = this.selectedRunId ? this.streams.get(this.selectedRunId) : undefined;
    const model: TuiFrameModel = {
      view: this.view,
      baseUrl: this.baseUrl,
      connected: this.connected,
      uptime: this.uptime,
      sessions: this.sessions,
      selectedSessionId: this.selectedSessionId,
      session: this.session,
      runs: this.runs,
      selectedRunId: this.selectedRunId,
      latest: this.latest,
      outputLines: stream?.buffer.tail(1200) || [],
      notice: this.notice,
      now: Date.now(),
    };
    const layout = renderTuiLayout(model, { width, height, color, interactive });
    this.hitTargets = layout.hits;
    return layout.frame;
  }

  async runInteractive(): Promise<number> {
    const input = process.stdin;
    const output = process.stdout;
    const color = !this.options.noColor && !process.env.NO_COLOR && process.env.TERM !== "dumb";
    await this.refresh();

    return await new Promise<number>((resolve) => {
      const draw = () => {
        output.write(`\x1b[H${this.frame(output.columns || 100, output.rows || 30, color)}\x1b[J`);
      };
      const schedule = () => {
        if (this.stopped) return;
        this.timer = setTimeout(async () => {
          await this.refresh();
          draw();
          schedule();
        }, this.options.refreshMs || 750);
        this.timer.unref?.();
      };
      const finish = (code: number) => {
        if (this.stopped) return;
        this.stopped = true;
        this.finishCode = code;
        if (this.timer) clearTimeout(this.timer);
        input.off("data", onData);
        output.off("resize", draw);
        process.off("SIGINT", onSigint);
        process.off("SIGTERM", onSigterm);
        try {
          input.setRawMode(false);
        } catch {
          /* terminal may already be closed */
        }
        input.pause();
        output.write(`${DISABLE_MOUSE}\x1b[?25h\x1b[?1049l`);
        resolve(this.finishCode);
      };
      const onSigint = () => finish(130);
      const onSigterm = () => finish(143);
      const onData = (chunk: Buffer | string) => {
        const key = chunk.toString();
        const mouseEvents = parseSgrMouse(key);
        if (mouseEvents.length) {
          for (const event of mouseEvents) {
            const action = this.handleMouse(event);
            if (action === "quit") return finish(0);
            if (action === "refresh") void this.refresh().then(draw);
          }
          draw();
          return;
        }
        if (key === "q" || key === "Q") return finish(0);
        if (key === "\x03") return finish(130);
        if (key === "\x1b" || key === "\x7f" || key === "h") {
          this.back();
          draw();
          return;
        }
        if (key === "\x1b[A" || key === "k" || key === "K") this.move(-1);
        else if (key === "\x1b[B" || key === "j" || key === "J") this.move(1);
        else if (key === "\r" || key === "\n") this.openSelected();
        else if (key === "r" || key === "R") void this.refresh().then(draw);
        draw();
      };

      output.write(`\x1b[?1049h\x1b[?25l${ENABLE_MOUSE}\x1b[2J`);
      try {
        input.setRawMode(true);
      } catch {
        output.write(`${DISABLE_MOUSE}\x1b[?25h\x1b[?1049l`);
        resolve(2);
        return;
      }
      input.resume();
      input.on("data", onData);
      output.on("resize", draw);
      process.on("SIGINT", onSigint);
      process.on("SIGTERM", onSigterm);
      draw();
      schedule();
    });
  }

  private async refreshHealthAndSessions(): Promise<void> {
    try {
      const [health, payload] = await Promise.all([
        this.getJson<HealthResponse>("/api/health"),
        this.getJson<SessionsResponse>("/api/sessions"),
      ]);
      this.connected = health.ok;
      this.uptime = health.uptime;
      this.sessions = payload.sessions || [];
      if (this.view === "sessions") {
        if (!this.sessions.some((item) => item.id === this.selectedSessionId)) {
          this.selectedSessionId = this.sessions[0]?.id;
        }
        this.notice = undefined;
      }
    } catch (err) {
      this.connected = false;
      this.notice = errorMessage(err, `Collector unavailable at ${this.baseUrl}.`);
    }
  }

  private async refreshSession(): Promise<void> {
    const id = this.selectedSessionId;
    if (!id) return;
    try {
      const payload = await this.getJson<SessionResponse>(`/api/sessions/${encodeURIComponent(id)}`);
      this.session = payload.session;
      this.runs = payload.runs || [];
      const rows = buildTreeRows(this.runs);
      if (!rows.some((row) => row.run.id === this.selectedRunId)) {
        this.selectedRunId = rows.find((row) => row.run.processState === "running")?.run.id || rows[0]?.run.id;
      }
      this.notice = undefined;
    } catch (err) {
      if (!(err instanceof HttpStatusError && err.status === 404 && this.session)) {
        this.notice = errorMessage(err, `Session ${id} is not active.`);
      } else {
        this.notice = "Session finished. Completed runs are not retained.";
      }
    }
    if (this.selectedRunId) await this.refreshRun(this.selectedRunId);
  }

  private async refreshRun(id: string): Promise<void> {
    const stream = this.streams.get(id) || {
      buffer: new TerminalBuffer(),
      decoder: new TextDecoder(),
      lastSeq: 0,
    };
    this.streams.set(id, stream);
    try {
      const [detail, payload] = await Promise.all([
        this.getJson<RunResponse>(`/api/runs/${encodeURIComponent(id)}`),
        this.getJson<EventsResponse>(`/api/runs/${encodeURIComponent(id)}/events?after=${stream.lastSeq}`),
      ]);
      if (this.selectedRunId === id) this.latest = detail.latest;
      const index = this.runs.findIndex((run) => run.id === detail.run.id);
      if (index >= 0) this.runs[index] = detail.run;
      else this.runs.push(detail.run);
      for (const event of [...(payload.events || [])].sort((a, b) => a.seq - b.seq)) {
        if (event.seq <= stream.lastSeq) continue;
        stream.lastSeq = event.seq;
        if (event.type === "raw" && event.b64) {
          stream.buffer.write(stream.decoder.decode(Buffer.from(event.b64, "base64"), { stream: true }));
        } else if (event.type === "exit") {
          stream.buffer.write(stream.decoder.decode());
        }
      }
      this.syncSessionState();
    } catch (err) {
      if (!(err instanceof HttpStatusError && err.status === 404)) {
        this.notice = errorMessage(err, `Run ${id} is unavailable.`);
      }
    }
  }

  private move(delta: number): void {
    if (this.view === "sessions") {
      if (!this.sessions.length) return;
      const current = Math.max(0, this.sessions.findIndex((item) => item.id === this.selectedSessionId));
      const next = Math.max(0, Math.min(this.sessions.length - 1, current + delta));
      this.selectedSessionId = this.sessions[next].id;
      return;
    }
    const rows = buildTreeRows(this.runs);
    if (!rows.length) return;
    const current = Math.max(0, rows.findIndex((row) => row.run.id === this.selectedRunId));
    const next = Math.max(0, Math.min(rows.length - 1, current + delta));
    this.selectRun(rows[next].run.id);
  }

  private handleMouse(event: TuiMouseEvent): "quit" | "refresh" | undefined {
    if (event.kind === "wheel-up") {
      this.move(-1);
      return;
    }
    if (event.kind === "wheel-down") {
      this.move(1);
      return;
    }
    if (event.kind !== "left" || event.release) return;
    const target = this.hitTargets.find((hit) => (
      hit.row === event.y && event.x >= hit.colStart && event.x <= hit.colEnd
    ));
    if (!target) return;
    return this.applyMouseAction(target.action);
  }

  private applyMouseAction(action: TuiMouseAction): "quit" | "refresh" | undefined {
    if (action.type === "quit") return "quit";
    if (action.type === "refresh") return "refresh";
    if (action.type === "back") {
      this.back();
      return;
    }
    if (action.type === "open-session") {
      this.selectedSessionId = action.id;
      this.openSelected();
      return;
    }
    this.selectRun(action.id);
    return;
  }

  private selectRun(id: string): void {
    if (!this.runs.some((run) => run.id === id)) return;
    this.selectedRunId = id;
    this.latest = undefined;
    void this.refreshRun(id);
  }

  private syncSessionState(): void {
    if (!this.session || !this.runs.length) return;
    const runningCount = this.runs.filter((run) => run.processState === "running").length;
    const hasUnknown = this.runs.some((run) => run.processState === "unknown");
    const status: SessionSummary["status"] = runningCount ? "running" : hasUnknown ? "unknown" : "exited";
    this.session = {
      ...this.session,
      status,
      runCount: this.runs.length,
      runningCount,
    };
  }

  private openSelected(): void {
    if (this.view !== "sessions" || !this.selectedSessionId) return;
    this.view = "session";
    this.session = undefined;
    this.runs = [];
    this.selectedRunId = undefined;
    this.latest = undefined;
    void this.refresh();
  }

  private back(): void {
    if (this.view === "sessions") return;
    this.view = "sessions";
    this.session = undefined;
    this.runs = [];
    this.selectedRunId = undefined;
    this.latest = undefined;
    this.notice = undefined;
    void this.refresh();
  }

  private async getJson<T>(path: string): Promise<T> {
    const response = await fetch(this.baseUrl + path, { signal: AbortSignal.timeout(1800) });
    if (!response.ok) throw new HttpStatusError(response.status, path);
    return await response.json() as T;
  }
}

export async function runTui(options: TuiOptions): Promise<number> {
  if (!options.once && (!process.stdin.isTTY || !process.stdout.isTTY)) {
    process.stderr.write("flowpeek tui requires an interactive terminal; use --once for a plain-text snapshot.\n");
    return 2;
  }
  const cfg = loadConfig({ project: options.project });
  if (!isLoopback(cfg.dashboard.host)) {
    process.stderr.write(`flowpeek tui refuses non-loopback collector host ${cfg.dashboard.host}.\n`);
    return 2;
  }
  const baseUrl = dashboardUrl(cfg.dashboard.host, cfg.dashboard.port);
  if (!(await ensureDaemon(cfg))) {
    process.stderr.write(`flowpeek tui could not reach the collector at ${baseUrl}.\n`);
    return 1;
  }

  const controller = new TuiController(baseUrl, options);
  if (options.once) {
    await controller.refresh();
    const width = positiveInt(process.env.COLUMNS, 100);
    const height = positiveInt(process.env.LINES, 30);
    process.stdout.write(controller.frame(width, height, false, false) + "\n");
    return 0;
  }
  return controller.runInteractive();
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof HttpStatusError && error.status === 404) return fallback;
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

export { TerminalBuffer } from "./terminal-buffer.js";
export { buildTreeRows } from "./tree.js";
export { renderTuiFrame } from "./render.js";
