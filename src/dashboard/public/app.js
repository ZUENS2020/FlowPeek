import { TermBuf } from "./term.js";

const app = document.getElementById("app");
const healthEl = document.getElementById("health");

function route() {
  const m = location.pathname.match(/^\/r\/([^/]+)/);
  if (m) return renderDetail(m[1]);
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
    healthEl.textContent = `daemon up ${h.uptime}s`;
    healthEl.classList.add("ok");
  } catch {
    healthEl.textContent = "daemon unreachable";
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

function card(run) {
  return `<a class="card" href="/r/${run.id}">
    <div><span class="badge ${run.processState}">${run.processState}</span>
      ${run.label ? `<span class="badge">${esc(run.label)}</span>` : ""}
      ${run.adapterId ? `<span class="badge">${esc(run.adapterId)}</span>` : ""}</div>
    <div class="cmd">${esc(fmtCmd(run))}</div>
    <div class="meta"><span>${esc(run.cwd)}</span><span>${elapsed(run)}</span>
      ${run.exitCode != null ? `<span>exit ${run.exitCode}</span>` : ""}
      ${run.droppedRawChunks ? `<span>dropped ${run.droppedRawChunks}</span>` : ""}</div>
  </a>`;
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
    data = await fetchJson("/api/runs");
  } catch {
    app.innerHTML = `<div class="empty">Cannot reach the local collector. Start it with <code>flowpeek daemon</code>.</div>`;
    return;
  }
  const runs = data.runs || [];
  const running = runs.filter((r) => r.processState === "running");
  const rest = runs.filter((r) => r.processState !== "running");
  if (!runs.length) {
    app.innerHTML = `<div class="empty">
      <h1>No runs yet</h1>
      <p>Wrap a long command. FlowPeek does not start or stop the process — it only observes.</p>
      <p><code>flowpeek run -- npm run build</code></p>
    </div>`;
    return;
  }
  app.innerHTML = `<div class="lists">
    <section>
      <h1>Running</h1>
      <div class="grid">${running.length ? running.map(card).join("") : `<div class="empty">Nothing running.</div>`}</div>
    </section>
    <section>
      <h1>Completed</h1>
      <div class="grid">${rest.length ? rest.map(card).join("") : `<div class="empty">No finished runs.</div>`}</div>
    </section>
  </div>`;
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
    app.innerHTML = `<div class="empty">Run not found.</div>`;
    return;
  }
  const run = payload.run;
  const latest = payload.latest || {};
  app.innerHTML = `
    <p><a href="/">← All runs</a></p>
    <h1 class="cmd">${esc(run.label || fmtCmd(run))}</h1>
    <div class="meta">
      <span class="badge ${run.processState}">${run.processState}</span>
      <span>${esc(fmtCmd(run))}</span>
      <span>${esc(run.cwd)}</span>
      <span>adapter ${esc(run.adapterId || "generic")}</span>
      ${run.exitCode != null ? `<span>exit ${run.exitCode}</span>` : ""}
    </div>
    <div id="banners"></div>
    <div class="kpis">
      <div class="kpi"><b>phase</b><span id="phase">${esc(latest.phase || "—")}</span></div>
      <div class="kpi"><b>elapsed</b><span id="elapsed">${elapsed(run)}</span></div>
      <div class="kpi"><b>adapter</b><span>${esc(run.adapterId || "generic")}</span></div>
      <div class="kpi"><b>dropped</b><span id="dropped">${run.droppedRawChunks || 0}</span></div>
    </div>
    <div id="pbar"></div>
    <ul class="notes" id="notes"></ul>
    <div class="term-wrap">
      <div class="term-head"><span>Live terminal (rolling buffer)</span><span id="termmeta">raw stream</span></div>
      <pre id="term"></pre>
    </div>
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
      bits.push(`<div class="banner warn">Telemetry dropped ${r.droppedRawChunks} raw chunks under backpressure. The real command was not stalled.</div>`);
    }
    if (!r.telemetryConnected && r.processState !== "exited") {
      bits.push(`<div class="banner lost">Telemetry connection lost. Process state is unknown — this does not mean the command failed.</div>`);
    }
    banners.innerHTML = bits.join("");
  }
  bannersFrom(run);

  function applyProgress(p) {
    if (!p) return;
    if (p.kind === "determinate" && p.total) {
      const pct = Math.max(0, Math.min(100, p.percent ?? (100 * p.current) / p.total));
      pbar.innerHTML = `<div class="progress"><span style="width:${pct}%"></span></div>
        <div class="meta">${esc(p.message || "")} ${p.current}/${p.total}</div>`;
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
    e.preventDefault();
    history.pushState({}, "", a.pathname);
    route();
  }
});
