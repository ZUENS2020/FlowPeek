import { readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { AppConfig } from "../types.js";
import { deleteRunRow, listRunIds } from "./db.js";
import { deleteRunLog, runLogSize } from "./log-store.js";
import { runsDir } from "../paths.js";

/**
 * Best-effort retention. Never signals, kills, or pauses a live process.
 * Live runs are left untouched even if over budget.
 */
export function sweepRetention(cfg: AppConfig, liveIds: Set<string>): void {
  const maxTotal = cfg.storage.max_total_mb * 1024 * 1024;
  const retainMs = cfg.storage.retain_days * 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - retainMs;
  const dir = runsDir();

  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".ndjson"));
  } catch {
    return;
  }

  const infos = files.map((f) => {
    const p = join(dir, f);
    const st = statSync(p);
    const id = f.replace(/\.ndjson$/, "");
    return { id, path: p, size: st.size, mtime: st.mtimeMs };
  });

  for (const info of infos) {
    if (liveIds.has(info.id)) continue;
    if (info.mtime < cutoff) {
      try {
        unlinkSync(info.path);
        deleteRunRow(info.id);
      } catch {
        /* ignore */
      }
    }
  }

  const remaining = infos
    .filter((i) => {
      try {
        return statSync(i.path).isFile();
      } catch {
        return false;
      }
    })
    .sort((a, b) => a.mtime - b.mtime);

  let total = remaining.reduce((s, i) => s + i.size, 0);
  for (const info of remaining) {
    if (total <= maxTotal) break;
    if (liveIds.has(info.id)) continue;
    try {
      unlinkSync(info.path);
      deleteRunRow(info.id);
      total -= info.size;
    } catch {
      /* ignore */
    }
  }

  // Clean db rows whose logs are gone (except live).
  for (const id of listRunIds()) {
    if (liveIds.has(id)) continue;
    if (runLogSize(id) === 0) {
      // keep metadata for recently exited runs; only drop if file missing AND old
    }
  }
}
