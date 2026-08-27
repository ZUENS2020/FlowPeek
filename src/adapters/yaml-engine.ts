import type { AdapterPattern, AdapterSpec, RunEvent } from "../types.js";
import { nowIso } from "../ids.js";

export type EmitFn = (partial: Omit<RunEvent, "runId" | "seq" | "ts"> & { ts?: string }) => void;

function expand(tmpl: string | undefined, m: RegExpMatchArray): string | undefined {
  if (!tmpl) return undefined;
  return tmpl.replace(/\{(\d+)\}/g, (_, n) => m[Number(n)] ?? "");
}

function num(tmpl: string | undefined, m: RegExpMatchArray): number | undefined {
  const s = expand(tmpl, m);
  if (s == null || s === "") return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

export function applyPatterns(
  spec: AdapterSpec,
  line: string,
  emit: EmitFn,
): void {
  const groups: Array<{ kind: string; pats: AdapterPattern[] }> = [
    { kind: "pattern", pats: spec.patterns || [] },
    { kind: "warning", pats: spec.warnings || [] },
    { kind: "error", pats: spec.errors || [] },
    { kind: "complete", pats: spec.complete || [] },
  ];
  for (const g of groups) {
    for (const p of g.pats) {
      let re: RegExp;
      try {
        re = new RegExp(p.regex, p.flags ?? "");
      } catch {
        continue;
      }
      const m = line.match(re);
      if (!m) continue;
      const kind = g.kind === "pattern" ? p.kind || "activity" : g.kind === "complete" ? "complete" : g.kind;
      const message = expand(p.message, m) || line.slice(0, 240);
      if (kind === "activity") {
        emit({ type: "activity", activity: message, message });
      } else if (kind === "phase") {
        emit({ type: "phase", phase: expand(p.phase, m) || message, message });
      } else if (kind === "progress") {
        const current = num(p.current, m);
        const total = num(p.total, m);
        const percent =
          current != null && total && total > 0 ? (current / total) * 100 : undefined;
        emit({
          type: "progress",
          progress: {
            kind: total ? "determinate" : "activity",
            current,
            total,
            percent,
            message,
            unit: p.unit,
          },
          message,
        });
      } else if (kind === "metric") {
        const value = num(p.value, m) ?? (Number(m[1]) || 0);
        emit({
          type: "metric",
          metric: { name: p.name || "value", value, unit: p.unit },
          message,
        });
      } else if (kind === "warning") {
        emit({ type: "warning", message });
      } else if (kind === "error") {
        emit({ type: "error", message });
      } else if (kind === "complete") {
        emit({ type: "phase", phase: "complete", message });
      } else if (kind === "heartbeat") {
        emit({ type: "heartbeat", message });
      }
    }
  }
}

export function splitLinesPreserveCR(chunk: string, pending: string): { lines: string[]; pending: string } {
  const s = pending + chunk;
  const lines: string[] = [];
  let buf = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\n") {
      lines.push(buf);
      buf = "";
    } else if (ch === "\r") {
      lines.push(buf);
      buf = "";
    } else {
      buf += ch;
    }
  }
  return { lines, pending: buf };
}

export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
}
