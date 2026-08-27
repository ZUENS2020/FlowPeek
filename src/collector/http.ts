import http from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AppConfig, RunEvent } from "../types.js";
import { isLoopback } from "../paths.js";
import { listAdapters } from "../adapters/resolve.js";
import type { RunRegistry } from "./registry.js";
import { getRun } from "../storage/db.js";
import { readLogEvents } from "../storage/log-store.js";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

function publicDir(): string {
  return fileURLToPath(new URL("../dashboard/public", import.meta.url));
}

function json(res: http.ServerResponse, body: unknown, status = 200): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(data);
}

function notFound(res: http.ServerResponse): void {
  json(res, { error: "not found" }, 404);
}

export function startHttpServer(
  cfg: AppConfig,
  registry: RunRegistry,
  startedAt: number,
  project: string,
): Promise<http.Server> {
  const host = cfg.dashboard.host;
  if (!isLoopback(host)) {
    throw new Error(
      `Refusing to bind dashboard to ${host}. FlowPeek is loopback-only (127.0.0.1 / localhost / ::1).`,
    );
  }
  const port = cfg.dashboard.port;
  const pub = publicDir();

  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url || "/", `http://${host}:${port}`);
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405);
        res.end();
        return;
      }
      const p = url.pathname;
      if (p === "/api/health") {
        const runs = registry.list();
        json(res, {
          ok: true,
          uptime: Math.round((Date.now() - startedAt) / 1000),
          runs: {
            running: runs.filter((r) => r.processState === "running").length,
            total: runs.length,
          },
        });
        return;
      }
      if (p === "/api/runs") {
        json(res, { runs: registry.list() });
        return;
      }
      const runMatch = p.match(/^\/api\/runs\/([^/]+)(?:\/(events|stream))?$/);
      if (runMatch) {
        const id = decodeURIComponent(runMatch[1]);
        const sub = runMatch[2];
        if (sub === "stream") {
          sseStream(req, res, id, registry);
          return;
        }
        const snap = registry.snapshot(id);
        const run = snap?.run || getRun(id);
        if (!run) {
          notFound(res);
          return;
        }
        if (sub === "events") {
          const after = Number(url.searchParams.get("after") || 0);
          const live = registry.live.get(id);
          const events = live
            ? [...live.rawRing, ...live.structured]
                .filter((e) => e.seq > after)
                .sort((a, b) => a.seq - b.seq)
            : readLogEvents(id, after, 8000);
          json(res, { events });
          return;
        }
        const live = registry.live.get(id);
        const latest = live?.latest || latestFrom(snap?.events || []);
        json(res, { run, latest, telemetry: { connected: run.telemetryConnected, dropped: run.droppedRawChunks } });
        return;
      }
      if (p === "/api/adapters") {
        json(res, {
          adapters: listAdapters(project).map((a) => ({
            id: a.spec.id,
            name: a.spec.name,
            source: a.source,
            path: a.path || null,
            kind: a.spec.kind || "yaml",
          })),
        });
        return;
      }
      serveStatic(res, pub, p);
    } catch (err) {
      json(res, { error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve(server));
  });
}

function latestFrom(events: RunEvent[]): Record<string, unknown> {
  let phase: string | undefined;
  let progress: RunEvent["progress"];
  const metrics: Record<string, { value: number; unit?: string }> = {};
  const warnings: string[] = [];
  const errors: string[] = [];
  for (const e of events) {
    if (e.type === "phase" && e.phase) phase = e.phase;
    if (e.type === "progress" && e.progress) progress = e.progress;
    if (e.type === "metric" && e.metric) metrics[e.metric.name] = { value: e.metric.value, unit: e.metric.unit };
    if (e.type === "warning" && e.message) warnings.push(e.message);
    if (e.type === "error" && e.message) errors.push(e.message);
  }
  return { phase, progress, metrics, warnings: warnings.slice(-20), errors: errors.slice(-20) };
}

function sseStream(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  id: string,
  registry: RunRegistry,
): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(":\n\n");
  const writeEv = (ev: RunEvent) => {
    try {
      const name = ev.type === "raw" || ev.type === "progress" || ev.type === "phase" || ev.type === "metric" || ev.type === "warning" || ev.type === "error" || ev.type === "exit" || ev.type === "heartbeat" || ev.type === "activity"
        ? ev.type
        : "message";
      res.write(`event: ${name}\n`);
      res.write(`data: ${JSON.stringify(ev)}\n\n`);
    } catch {
      /* ignore */
    }
  };
  const snap = registry.snapshot(id);
  if (snap) {
    for (const ev of snap.events.slice(-500)) writeEv(ev);
  }
  const unsub = registry.subscribe(id, writeEv);
  const keep = setInterval(() => {
    try {
      res.write(`event: ping\ndata: {}\n\n`);
    } catch {
      /* closed */
    }
  }, 15000);
  keep.unref?.();
  req.on("close", () => {
    clearInterval(keep);
    unsub();
  });
}

function serveStatic(res: http.ServerResponse, pub: string, pathname: string): void {
  let rel = pathname;
  if (rel === "/" || rel.startsWith("/r/")) rel = "/index.html";
  const safe = join(pub, rel.replace(/^\/+/, ""));
  if (!safe.startsWith(pub) || !existsSync(safe) || !statSync(safe).isFile()) {
    const index = join(pub, "index.html");
    if (existsSync(index) && (pathname === "/" || pathname.startsWith("/r/"))) {
      streamFile(res, index);
      return;
    }
    res.writeHead(404);
    res.end("not found");
    return;
  }
  streamFile(res, safe);
}

function streamFile(res: http.ServerResponse, file: string): void {
  const ext = extname(file);
  res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
  createReadStream(file).pipe(res);
}
