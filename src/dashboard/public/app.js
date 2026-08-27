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
    app.innerHTML = `<div class="empty invite">
      <h1>Collector unreachable</h1>
      <p>This dashboard talks to the local daemon on this port. Start it with <code>flowpeek daemon</code>.</p>
    </div>`;
    return;
  }
  const runs = data.runs || [];
  const running = runs.filter((r) => r.processState === "running");
  const rest = runs.filter((r) => r.processState !== "running");
  if (!runs.length) {
    app.innerHTML = `<div class="empty invite">
      <h1>Nothing to watch</h1>
      <p>Wrap a long command. FlowPeek only observes — it never starts or stops the process.</p>
      <p><code>flowpeek run -- npm run build</code></p>
    </div>`;
    return;
  }
  app.innerHTML = `<div class="scan">
    <section class="lane">
      <div class="lane-head"><h1>Live</h1><span class="count">${running.length}</span></div>
      <div class="grid">${running.length ? running.map(card).join("") : `<div class="empty">Quiet. No live commands.</div>`}</div>
    </section>
    <section class="lane">
      <div class="lane-head"><h1>Recent</h1><span class="count">${rest.length}</span></div>
      <div class="grid">${rest.length ? rest.map(card).join("") : `<div class="empty">No recent runs.</div>`}</div>
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
    <p class="crumb"><a href="/">Runs</a></p>
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
