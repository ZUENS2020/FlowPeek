import { TermBuf } from "./term.js";

const app = document.getElementById("app");
const healthEl = document.getElementById("health");
let activeCleanup = () => {};

function route() {
  activeCleanup();
  activeCleanup = () => {};
  const s = location.pathname.match(/^\/s\/([^/]+)/);
  if (s) return renderSession(decodeURIComponent(s[1]));
  const m = location.pathname.match(/^\/r\/([^/]+)/);
  if (m) return renderDetail(m[1]);
  const refresh = setInterval(() => void renderHome(), 2000);
  activeCleanup = () => clearInterval(refresh);
  return renderHome();
}

async function fetchJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
}

async function ping() {
  try {
    const h = await fetchJson("/api/health");
    healthEl.textContent = `up ${h.uptime}s`;
    healthEl.classList.add("ok");
  } catch {
    healthEl.textContent = "collector unreachable";
    healthEl.classList.remove("ok");
  }
}

function fmtCmd(run) {
  return (run.command || []).join(" ");
}

function elapsed(run) {
  const end = run.endedAt ? Date.parse(run.endedAt) : Date.now();
  const s = Math.max(0, Math.round((end - Date.parse(run.startedAt)) / 1000));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function irisClass(state) {
  if (state === "running") return "iris live";
  if (state === "unknown") return "iris lost";
  return "iris";
}

function cardFlags(run) {
  const bits = [];
  if (run.label) bits.push(`<span class="badge">${esc(run.label)}</span>`);
  if (run.adapterId) bits.push(`<span class="badge">${esc(run.adapterId)}</span>`);
  return bits.length ? `<div class="flags">${bits.join("")}</div>` : "";
}

function cwdSpan(cwd) {
  const path = esc(cwd);
  return `<span class="cwd" title="${path}">${path}</span>`;
}

function projectName(cwd) {
  const parts = String(cwd || "").split(/[\\/]+/).filter(Boolean);
  return parts.at(-1) || "Session";
}

function sessionTitle(session) {
  return session.agentName || projectName(session.cwd);
}

function sessionCard(session) {
  const live = session.status === "running";
  const details = [
    `${session.runCount} run${session.runCount === 1 ? "" : "s"}`,
    session.rootCount > 1 ? `${session.rootCount} roots` : "",
    session.runningCount ? `${session.runningCount} running` : "",
    elapsed(session),
  ].filter(Boolean);
  return `<a class="card session-card${live ? " is-live" : ""}" href="/s/${encodeURIComponent(session.id)}">
    <span class="${irisClass(session.status)}" aria-hidden="true"></span>
    <div class="card-main">
      <div class="flags"><span class="badge">session</span></div>
      <div class="cmd">${esc(sessionTitle(session))}</div>
      <div class="meta"><span class="cwd" title="${esc(session.id)}">${esc(session.id)}</span>${details.map((d) => `<span>${esc(d)}</span>`).join("")}</div>
    </div>
  </a>`;
}

function card(run) {
  const live = run.processState === "running";
  return `<a class="card${live ? " is-live" : ""}" href="/r/${run.id}">
    <span class="${irisClass(run.processState)}" aria-hidden="true"></span>
    <div class="card-main">
      ${cardFlags(run)}
      <div class="cmd">${esc(fmtCmd(run))}</div>
      <div class="meta">${cwdSpan(run.cwd)}<span>${elapsed(run)}</span>
        ${run.exitCode != null ? `<span>exit ${run.exitCode}</span>` : ""}
        ${run.droppedRawChunks ? `<span class="warn">dropped ${run.droppedRawChunks}</span>` : ""}</div>
    </div>
  </a>`;
}

function progressLabel(p) {
  const frac = p.current != null && p.total != null ? `${p.current}/${p.total}` : "";
  const msg = String(p.message || "").trim();
  if (!frac) return msg;
  if (!msg || msg === frac) return frac;
  if (msg.includes(frac)) return msg;
  return `${msg} ${frac}`;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

async function renderHome() {
  document.title = "FlowPeek";
  let data;
  try {
    data = await fetchJson("/api/sessions");
  } catch {
    app.innerHTML = `<div class="empty invite">
      <h1>Collector unreachable</h1>
      <p>This dashboard talks to the local daemon on this port. Start it with <code>flowpeek daemon</code>.</p>
    </div>`;
    return;
  }
  const sessions = data.sessions || [];
  if (!sessions.length) {
    app.innerHTML = `<div class="empty invite">
      <h1>Nothing to watch</h1>
      <p>Wrap a long command. FlowPeek only observes — it never starts or stops the process.</p>
      <p><code>flowpeek run -- npm run build</code></p>
      <p>Finished sessions are not stored.</p>
    </div>`;
    return;
  }
  app.innerHTML = `<div class="scan">
    <section class="lane">
      <div class="lane-head"><h1>Live</h1><span class="count">${sessions.length}</span></div>
      <div class="grid">${sessions.map(sessionCard).join("")}</div>
    </section>
  </div>`;
}

function treeModel(runs) {
  const ordered = [...runs].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const byId = new Map(ordered.map((run) => [run.id, run]));
  const safeParent = new Map();
  for (const run of ordered) {
    if (!run.parentRunId || !byId.has(run.parentRunId) || run.parentRunId === run.id) {
      safeParent.set(run.id, null);
      continue;
    }
    const seen = new Set([run.id]);
    let cursor = run.parentRunId;
    let cyclic = false;
    while (cursor && byId.has(cursor)) {
      if (seen.has(cursor)) {
        cyclic = true;
        break;
      }
      seen.add(cursor);
      cursor = byId.get(cursor).parentRunId;
    }
    safeParent.set(run.id, cyclic ? null : run.parentRunId);
  }
  const children = new Map();
  const roots = [];
  for (const run of ordered) {
    const parent = safeParent.get(run.id);
    if (!parent) roots.push(run);
    else {
      const bucket = children.get(parent) || [];
      bucket.push(run);
      children.set(parent, bucket);
    }
  }
  return { roots, children };
}

function runNode(run, children, depth = 0, visited = new Set()) {
  if (visited.has(run.id)) return "";
  const nextVisited = new Set(visited);
  nextVisited.add(run.id);
  const nested = children.get(run.id) || [];
  return `<li class="run-node" style="--depth:${depth}">
    <a href="/r/${encodeURIComponent(run.id)}">
      <span class="${irisClass(run.processState)}" aria-hidden="true"></span>
      <span class="run-node-main"><span class="cmd">${esc(run.label || fmtCmd(run))}</span>
      <span class="meta"><span>${elapsed(run)}</span>${run.exitCode != null ? `<span>exit ${run.exitCode}</span>` : ""}</span></span>
    </a>
    ${nested.length ? `<ul>${nested.map((child) => runNode(child, children, depth + 1, nextVisited)).join("")}</ul>` : ""}
  </li>`;
}

async function renderSession(id) {
  document.title = `Session ${id} · FlowPeek`;
  let stopped = false;
  let timer;
  activeCleanup = () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };

  const refresh = async () => {
    let payload;
    try {
      payload = await fetchJson(`/api/sessions/${encodeURIComponent(id)}`);
    } catch {
      if (!stopped) {
        app.innerHTML = `<div class="empty invite"><h1>Session not found</h1><p>It may have been pruned, or the id is wrong.</p></div>`;
      }
      return;
    }
    if (stopped) return;
    const session = payload.session;
    const runs = payload.runs || [];
    const { roots, children } = treeModel(runs);
    app.innerHTML = `
      <p class="crumb"><a href="/">Sessions</a></p>
      <header class="run-head session-head">
        <span class="${irisClass(session.status)}" aria-hidden="true"></span>
        <div class="run-titles">
          <h1 class="cmd">${esc(sessionTitle(session))}</h1>
          <div class="cmd-inline">${esc(session.id)}</div>
          <div class="meta"><span>${session.runCount} runs</span><span>${session.rootCount} roots</span><span>${elapsed(session)}</span></div>
        </div>
      </header>
      <section class="session-tree" aria-label="Session run tree">
        <ul>${roots.map((root) => runNode(root, children)).join("")}</ul>
      </section>`;
    timer = setTimeout(refresh, 2000);
  };
  await refresh();
}

function fromB64(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

async function renderDetail(id) {
  document.title = `Run ${id} · FlowPeek`;
  let payload;
  try {
    payload = await fetchJson(`/api/runs/${id}`);
  } catch {
    app.innerHTML = `<div class="empty invite">
      <h1>Run not found</h1>
      <p>It may have been pruned, or the id is wrong.</p>
    </div>`;
    return;
  }
  const run = payload.run;
  const latest = payload.latest || {};
  app.innerHTML = `
    <a class="skip" href="#term">Skip to live output</a>
    <p class="crumb"><a href="/">Sessions</a> / <a href="/s/${encodeURIComponent(run.sessionId)}">Session</a> / Run</p>
    <header class="run-head">
      <span class="${irisClass(run.processState)}" id="run-iris" aria-hidden="true"></span>
      <div class="run-titles">
        <h1 class="cmd">${esc(run.label || fmtCmd(run))}</h1>
        ${run.label ? `<div class="cmd-inline">${esc(fmtCmd(run))}</div>` : ""}
        <div class="meta">
          ${cwdSpan(run.cwd)}
          ${run.exitCode != null ? `<span id="exit-meta">exit ${run.exitCode}</span>` : ""}
        </div>
      </div>
    </header>
    <div id="banners"></div>
    <div class="status-strip">
      <div class="stat"><b>phase</b><span id="phase">${esc(latest.phase || "—")}</span></div>
      <div class="stat"><b>elapsed</b><span id="elapsed">${elapsed(run)}</span></div>
      <div class="stat"><b>adapter</b><span>${esc(run.adapterId || "generic")}</span></div>
      <div class="stat"><b>dropped</b><span id="dropped">${run.droppedRawChunks || 0}</span></div>
    </div>
    <div id="pbar"></div>
    <div class="term-wrap${run.processState === "running" ? " is-live" : ""}" id="term-wrap">
      <div class="term-head"><span>Live output</span><span id="termmeta">raw stream</span></div>
      <pre id="term" tabindex="0"></pre>
    </div>
    <ul class="notes" id="notes"></ul>
  `;
  const term = new TermBuf();
  const pre = document.getElementById("term");
  const banners = document.getElementById("banners");
  const notes = document.getElementById("notes");
  const phaseEl = document.getElementById("phase");
  const droppedEl = document.getElementById("dropped");
  const pbar = document.getElementById("pbar");
  const elapsedEl = document.getElementById("elapsed");
  let lastSeq = 0;
  let paintScheduled = false;
  let stick = true;

  function bannersFrom(r) {
    const bits = [];
    if (r.droppedRawChunks) {
      bits.push(`<div class="banner warn">Dropped ${r.droppedRawChunks} raw chunks under backpressure. The command was not stalled.</div>`);
    }
    if (!r.telemetryConnected && r.processState !== "exited") {
      bits.push(`<div class="banner lost">Telemetry lost. Process state is unknown — the command may still be running.</div>`);
    }
    banners.innerHTML = bits.join("");
  }
  bannersFrom(run);

  function applyProgress(p) {
    if (!p) return;
    if (p.kind === "determinate" && p.total) {
      const pct = Math.max(0, Math.min(100, p.percent ?? (100 * p.current) / p.total));
      pbar.innerHTML = `<div class="progress"><span style="width:${pct}%"></span></div>
        <div class="meta">${esc(progressLabel(p))}</div>`;
    } else if (p.message) {
      pbar.innerHTML = `<div class="meta">${esc(p.message)}</div>`;
    }
  }
  applyProgress(latest.progress);

  function addNote(cls, msg) {
    const li = document.createElement("li");
    li.className = cls;
    li.textContent = msg;
    notes.appendChild(li);
    while (notes.children.length > 40) notes.removeChild(notes.firstChild);
  }

  function paint() {
    if (paintScheduled) return;
    paintScheduled = true;
    requestAnimationFrame(() => {
      paintScheduled = false;
      pre.textContent = term.text();
      if (stick) pre.scrollTop = pre.scrollHeight;
    });
  }

  function markExited(code) {
    const iris = document.getElementById("run-iris");
    if (iris) iris.className = "iris";
    document.getElementById("term-wrap")?.classList.remove("is-live");
    const meta = document.querySelector(".run-titles .meta");
    if (meta && code != null && !document.getElementById("exit-meta")) {
      const span = document.createElement("span");
      span.id = "exit-meta";
      span.textContent = `exit ${code}`;
      meta.appendChild(span);
    }
  }

  function applyEvent(d) {
    if (!d) return;
    if (typeof d.seq === "number") {
      if (d.seq <= lastSeq) return;
      lastSeq = d.seq;
    }
    switch (d.type) {
      case "raw":
        if (d.b64) term.write(fromB64(d.b64));
        if (d.dropped) droppedEl.textContent = String(d.dropped);
        paint();
        break;
      case "phase":
        if (d.phase) phaseEl.textContent = d.phase;
        break;
      case "progress":
        applyProgress(d.progress);
        break;
      case "activity":
        if (d.activity) document.getElementById("termmeta").textContent = d.activity;
        break;
      case "warning":
        addNote("warn", d.message || "warning");
        break;
      case "error":
        addNote("err", d.message || "error");
        break;
      case "heartbeat":
        if (d.dropped) droppedEl.textContent = String(d.dropped);
        elapsedEl.textContent = elapsed(run);
        break;
      case "exit":
        phaseEl.textContent = "exited";
        markExited(d.exitCode);
        addNote("", `process exited ${d.exitCode ?? ""} ${d.signal || ""}`.trim());
        break;
      default:
        break;
    }
  }

  try {
    const hist = await fetchJson(`/api/runs/${id}/events`);
    const evs = (hist.events || []).slice().sort((a, b) => (a.seq || 0) - (b.seq || 0));
    for (const ev of evs) applyEvent(ev);
    paint();
  } catch {
    /* live SSE still hydrates */
  }

  const es = new EventSource(`/api/runs/${id}/stream`);
  activeCleanup = () => es.close();
  pre.addEventListener("scroll", () => {
    stick = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 24;
  });
  const onSse = (ev) => {
    try {
      applyEvent(JSON.parse(ev.data));
    } catch {
      /* ignore */
    }
  };
  for (const name of ["raw", "phase", "progress", "activity", "warning", "error", "heartbeat", "exit"]) {
    es.addEventListener(name, onSse);
  }
  window.addEventListener("beforeunload", () => es.close(), { once: true });
}

ping();
setInterval(ping, 5000);
route();
window.addEventListener("popstate", route);
document.addEventListener("click", (e) => {
  const a = e.target.closest("a");
  if (a && a.origin === location.origin && a.pathname.startsWith("/")) {
    if (a.hash && a.pathname === location.pathname) return;
    e.preventDefault();
    history.pushState({}, "", a.pathname);
    route();
  }
});
