import type { AgentOutputMode, ProgressPayload, RunEvent } from "../types.js";

export function formatDeterminateProgress(p: Pick<ProgressPayload, "current" | "total" | "message">): string {
  const frac = p.current != null && p.total != null ? `${p.current}/${p.total}` : "";
  const msg = (p.message || "").trim();
  if (!frac) return msg;
  if (!msg || msg === frac) return frac;
  if (msg.includes(frac)) return msg;
  return `${msg} ${frac}`;
}

function alertDedupeKey(kind: string, msg: string): string | null {
  if (kind !== "[warning]" && kind !== "[error]") return null;
  const core = msg.replace(/^(?:warning|warn|error|fatal|panic):\s*/i, "").trim().toLowerCase();
  return `${kind}:${core}`;
}

const WARNING_RE = /(?:^|\b)(?:warning|warn)[:\s]/i;
const ERROR_RE =
  /(?:^|\b)(?:error|fatal|panic)[:\s]|\bnpm ERR!|\bFAILED\b|\bEADDRINUSE\b/i;

export class CompactPrinter {
  private lastHeartbeat = 0;
  private started = Date.now();
  private bytes = 0;
  private lastActivity = Date.now();
  private phase = "running";
  private lineBuf = "";
  private printedPhases = new Set<string>();
  private printedAlerts = new Set<string>();
  enabled: boolean;

  constructor(
    private readonly mode: AgentOutputMode,
    private readonly heartbeatSeconds: number,
    private readonly write = (s: string) => process.stderr.write(s),
  ) {
    this.enabled = mode === "compact";
  }

  onRaw(chunk: string): void {
    if (!this.enabled) return;
    this.bytes += Buffer.byteLength(chunk);
    this.lastActivity = Date.now();
    this.lineBuf += chunk;
    this.lineBuf = this.lineBuf.replace(/\r\n/g, "\n");
    // Treat CR as a line boundary for heuristics, without dumping every progress tick.
    const parts = this.lineBuf.split(/\r|\n/);
    this.lineBuf = parts.pop() || "";
    for (const line of parts) {
      const t = line.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").trim();
      if (!t) continue;
      if (ERROR_RE.test(t)) this.line("[error]", t.slice(0, 240));
      else if (WARNING_RE.test(t)) this.line("[warning]", t.slice(0, 240));
    }
  }

  onEvent(ev: RunEvent): void {
    if (!this.enabled) return;
    switch (ev.type) {
      case "phase":
        if (ev.phase && !this.printedPhases.has(ev.phase)) {
          this.printedPhases.add(ev.phase);
          this.phase = ev.phase;
          this.line("[phase]", ev.phase);
        }
        break;
      case "progress": {
        const p = ev.progress;
        if (!p) break;
        if (p.kind === "determinate" && p.total && p.current != null) {
          this.line("[progress]", formatDeterminateProgress(p));
        } else if (p.message) {
          this.line("[progress]", p.message);
        }
        break;
      }
      case "activity":
        if (ev.activity) this.line("[activity]", ev.activity);
        break;
      case "warning":
        if (ev.message) this.line("[warning]", ev.message);
        break;
      case "error":
        if (ev.message) this.line("[error]", ev.message);
        break;
      case "heartbeat":
        this.emitHeartbeat(true);
        break;
      default:
        break;
    }
  }

  maybeHeartbeat(): void {
    if (!this.enabled) return;
    const every = this.heartbeatSeconds * 1000;
    if (Date.now() - this.lastHeartbeat >= every) this.emitHeartbeat(false);
  }

  complete(code: number | null, signal: string | null): void {
    if (!this.enabled) return;
    const sec = ((Date.now() - this.started) / 1000).toFixed(1);
    const why = signal ? `signal ${signal}` : `exit ${code ?? 0}`;
    this.line("[completed]", `${why} in ${sec}s, ${this.humanBytes(this.bytes)} captured`);
  }

  start(): void {
    if (!this.enabled) return;
    this.line("[phase]", "started");
    this.printedPhases.add("started");
  }

  private emitHeartbeat(force: boolean): void {
    if (!force && Date.now() - this.lastHeartbeat < 1000) return;
    this.lastHeartbeat = Date.now();
    const elapsed = Math.round((Date.now() - this.started) / 1000);
    const ago = Math.round((Date.now() - this.lastActivity) / 1000);
    this.line(
      "[heartbeat]",
      `${this.phase} ${elapsed}s, ${this.humanBytes(this.bytes)}, last activity ${ago}s ago`,
    );
  }

  private line(kind: string, msg: string): void {
    const key = alertDedupeKey(kind, msg);
    if (key) {
      if (this.printedAlerts.has(key)) return;
      this.printedAlerts.add(key);
    }
    this.write(`[flowpeek] ${kind} ${msg}\n`);
  }

  private humanBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  }
}
