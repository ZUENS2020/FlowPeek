import type { RunRecord } from "../types.js";

export interface TuiTreeRow {
  run: RunRecord;
  prefix: string;
  depth: number;
}

/** Build a stable tree while degrading missing parents and cycles to roots. */
export function buildTreeRows(runs: RunRecord[]): TuiTreeRow[] {
  const ordered = [...runs].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const byId = new Map(ordered.map((run) => [run.id, run]));
  const safeParent = new Map<string, string | undefined>();

  for (const run of ordered) {
    if (!run.parentRunId || !byId.has(run.parentRunId) || run.parentRunId === run.id) {
      safeParent.set(run.id, undefined);
      continue;
    }
    const seen = new Set([run.id]);
    let cursor: RunRecord | undefined = byId.get(run.parentRunId);
    let cyclic = false;
    while (cursor) {
      if (seen.has(cursor.id)) {
        cyclic = true;
        break;
      }
      seen.add(cursor.id);
      cursor = cursor.parentRunId ? byId.get(cursor.parentRunId) : undefined;
    }
    safeParent.set(run.id, cyclic ? undefined : run.parentRunId);
  }

  const roots: RunRecord[] = [];
  const children = new Map<string, RunRecord[]>();
  for (const run of ordered) {
    const parent = safeParent.get(run.id);
    if (!parent) roots.push(run);
    else {
      const bucket = children.get(parent) || [];
      bucket.push(run);
      children.set(parent, bucket);
    }
  }

  const rows: TuiTreeRow[] = [];
  const visited = new Set<string>();
  const walk = (run: RunRecord, prefix: string, branch: string, depth: number): void => {
    if (visited.has(run.id)) return;
    visited.add(run.id);
    rows.push({ run, prefix: prefix + branch, depth });
    const nested = children.get(run.id) || [];
    nested.forEach((child, index) => {
      const last = index === nested.length - 1;
      walk(child, prefix + (branch ? (branch === "└─" ? "  " : "│ ") : ""), last ? "└─" : "├─", depth + 1);
    });
  };

  roots.forEach((root) => walk(root, "", "", 0));
  // Defensive fallback: malformed data must never disappear from the TUI.
  for (const run of ordered) {
    if (!visited.has(run.id)) walk(run, "", "", 0);
  }
  return rows;
}
