import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { inspectAdapter, listAdapters, parseAdapterFile, resolveAdapter } from "./resolve.js";
import { yamlFromSpec } from "./builtin.js";
import { projectAdapterDir, projectRoot } from "../paths.js";
import type { AdapterSpec, ResolvedAdapter, RunEvent } from "../types.js";

export function cmdAdapterList(project: string): number {
  const all = listAdapters(project);
  for (const a of all) {
    const src = a.path ? `${a.source} ${a.path}` : a.source;
    process.stdout.write(`${a.spec.id.padEnd(18)} ${String(a.spec.kind || "yaml").padEnd(8)} ${src}\n`);
  }
  return 0;
}

export function cmdAdapterResolve(command: string[], project: string, json = false): number {
  const a = resolveAdapter(command, project, project, "auto");
  if (json) {
    process.stdout.write(JSON.stringify({ id: a.spec.id, source: a.source, path: a.path || null }) + "\n");
  } else {
    process.stdout.write(`${a.spec.id} (${a.source}${a.path ? " " + a.path : ""})\n`);
  }
  return 0;
}

export function cmdAdapterInspect(id: string, project: string): number {
  const a = inspectAdapter(id, project);
  if (!a) {
    process.stderr.write(`adapter not found: ${id}\n`);
    return 1;
  }
  process.stdout.write(`id: ${a.spec.id}\n`);
  process.stdout.write(`name: ${a.spec.name}\n`);
  process.stdout.write(`source: ${a.source}\n`);
  if (a.path) process.stdout.write(`path: ${a.path}\n`);
  process.stdout.write(`kind: ${a.spec.kind || "yaml"}\n`);
  process.stdout.write("---\n");
  if (a.spec.kind === "script" && a.spec.script) process.stdout.write(a.spec.script);
  else process.stdout.write(yamlFromSpec(a.spec));
  return 0;
}

export function validateSpec(spec: AdapterSpec): string[] {
  const errors: string[] = [];
  if (!spec.id || !/^[a-zA-Z0-9._-]+$/.test(spec.id)) errors.push("invalid or missing id");
  if (!spec.name) errors.push("missing name");
  if (!spec.match) errors.push("missing match");
  const pats = [
    ...(spec.patterns || []),
    ...(spec.warnings || []),
    ...(spec.errors || []),
    ...(spec.complete || []),
  ];
  for (const p of pats) {
    try {
      new RegExp(p.regex, p.flags ?? "");
    } catch (e) {
      errors.push(`invalid regex ${p.regex}: ${e instanceof Error ? e.message : e}`);
    }
  }
  if (spec.kind === "script" && !spec.script) errors.push("script adapter missing script body");
  return errors;
}

export function cmdAdapterValidate(pathOrId: string | undefined, project: string): number {
  try {
    let spec: AdapterSpec;
    if (!pathOrId) {
      process.stderr.write("usage: flowpeek adapter validate <path|id>\n");
      return 2;
    }
    if (existsSync(pathOrId)) {
      spec = parseAdapterFile(pathOrId);
    } else {
      const a = inspectAdapter(pathOrId, project);
      if (!a) {
        process.stderr.write(`adapter not found: ${pathOrId}\n`);
        return 1;
      }
      spec = a.spec;
    }
    const errors = validateSpec(spec);
    if (errors.length) {
      for (const e of errors) process.stdout.write(`error: ${e}\n`);
      return 1;
    }
    process.stdout.write(`ok ${spec.id}\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`validate failed: ${err instanceof Error ? err.message : err}\n`);
    return 1;
  }
}

export async function cmdAdapterTest(opts: {
  target: string;
  fixture?: string;
  json?: boolean;
  report?: boolean;
  project: string;
}): Promise<number> {
  let resolved;
  if (existsSync(opts.target)) {
    const spec = parseAdapterFile(opts.target);
    resolved = { spec, source: "project" as const, path: opts.target };
  } else {
    resolved = inspectAdapter(opts.target, opts.project);
  }
  if (!resolved) {
    process.stderr.write(`adapter not found: ${opts.target}\n`);
    return 1;
  }
  const errors = validateSpec(resolved.spec);
  if (opts.report && (!opts.fixture || !existsSync(opts.fixture))) {
    process.stderr.write("adapter report requires an existing --fixture file\n");
    return 1;
  }
  const text = opts.fixture && existsSync(opts.fixture) ? readFixture(opts.fixture) : sampleFor(resolved.spec.id);
  if (opts.report) {
    return cmdAdapterReport({ resolved, text, errors, json: Boolean(opts.json) });
  }
  if (errors.length) {
    process.stderr.write(errors.join("\n") + "\n");
    return 1;
  }
  const { replayAdapter } = await import("./engine.js");
  const result = await replayAdapter(resolved, text);
  if (opts.json) {
    process.stdout.write(
      JSON.stringify(
        {
          id: resolved.spec.id,
          source: resolved.source,
          disabled: result.disabled,
          reason: result.reason || null,
          events: result.events.map((e) => ({
            type: e.type,
            phase: e.phase,
            message: e.message,
            activity: e.activity,
            progress: e.progress,
            metric: e.metric,
          })),
        },
        null,
        2,
      ) + "\n",
    );
  } else {
    process.stdout.write(`adapter ${resolved.spec.id} events=${result.events.length} disabled=${result.disabled}\n`);
    for (const e of result.events.slice(0, 50)) {
      process.stdout.write(`  ${e.type}${e.phase ? " " + e.phase : ""}${e.message ? " " + e.message : ""}\n`);
    }
  }
  return result.disabled ? 1 : 0;
}

async function cmdAdapterReport(opts: {
  resolved: ResolvedAdapter;
  text: string;
  errors: string[];
  json: boolean;
}): Promise<number> {
  const matched: Record<string, number> = {
    phase: 0,
    progress: 0,
    activity: 0,
    metric: 0,
    warning: 0,
    error: 0,
    heartbeat: 0,
  };
  let disabled = false;
  let disabledReason = "";
  let events: RunEvent[] = [];
  if (!opts.errors.length) {
    const { replayAdapterReport } = await import("./engine.js");
    const replay = await replayAdapterReport(opts.resolved, opts.text);
    events = replay.events;
    disabled = replay.disabled;
    disabledReason = replay.reason;
    for (const event of events) {
      if (event.type in matched) matched[event.type] += 1;
    }
  }
  const latestDeterminate = [...events]
    .reverse()
    .find((event) => event.type === "progress" && event.progress?.kind === "determinate")
    ?.progress;
  const matchedTotal = Object.values(matched).reduce((sum, count) => sum + count, 0);
  const pass = opts.errors.length === 0 && !disabled && matchedTotal > 0;
  const reason = opts.errors.length
    ? opts.errors.join("; ")
    : disabled
      ? disabledReason || "adapter disabled"
      : matchedTotal === 0
        ? "no adapter events matched fixture"
        : null;
  const report = {
    id: opts.resolved.spec.id,
    source: opts.resolved.source,
    input: {
      bytes: Buffer.byteLength(opts.text),
      lines: countFixtureLines(opts.text),
    },
    matched,
    progress: {
      determinate: Boolean(latestDeterminate),
      latest: latestDeterminate || null,
    },
    disabled,
    disabledReason: disabledReason || null,
    validationErrors: opts.errors,
    result: pass ? "PASS" : "FAIL",
    reason,
  };
  if (opts.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    process.stdout.write(`Adapter: ${report.id}\n\n`);
    process.stdout.write(`Input:\n  ${report.input.lines} lines\n  ${report.input.bytes} bytes\n\n`);
    process.stdout.write("Matched:\n");
    for (const [type, count] of Object.entries(matched)) {
      process.stdout.write(`  ${type.padEnd(10)} ${count}\n`);
    }
    process.stdout.write("\nProgress:\n");
    process.stdout.write(`  determinate: ${report.progress.determinate ? "yes" : "no"}\n`);
    if (latestDeterminate) {
      process.stdout.write(`  latest: ${latestDeterminate.current ?? "?"} / ${latestDeterminate.total ?? "?"}\n`);
    }
    process.stdout.write(`\nResult:\n  ${report.result}${reason ? ` — ${reason}` : ""}\n`);
  }
  return pass ? 0 : 1;
}

function readFixture(path: string): string {
  return readFileSync(path, "utf8");
}

function countFixtureLines(text: string): number {
  if (!text.length) return 0;
  const breaks = (text.match(/\r\n|\r|\n/g) || []).length;
  return breaks + (/(?:\r\n|\r|\n)$/.test(text) ? 0 : 1);
}

function sampleFor(id: string): string {
  if (id === "cargo-build") {
    return "   Compiling serde v1.0.0\nwarning: unused variable: x\n   Compiling foo v0.1.0\n    Finished `dev` profile [unoptimized + debuginfo] target(s) in 1.23s\n";
  }
  if (id === "npm-install") {
    return "npm warn deprecated foo@1.0.0\nadded 42 packages in 3s\n";
  }
  if (id === "pytest") {
    return "============================= test session starts ==============================\ncollected 3 items\ntest_foo.py::test_ok PASSED\n============================== 3 passed in 0.12s ===============================\n";
  }
  if (id === "ffmpeg") {
    return "Duration: 00:00:10.00\rframe=  12 fps=30 time=00:00:00.40 speed=1.2x\r";
  }
  if (id === "docker-build") {
    return "Step 3/9 : RUN echo hi\n ---> abc\n";
  }
  return "hello\nwarning: something\nerror: boom\n";
}

export function cmdAdapterScaffold(id: string, kind: "yaml" | "script", project: string): number {
  if (!/^[a-zA-Z0-9._-]+$/.test(id)) {
    process.stderr.write("invalid adapter id\n");
    return 2;
  }
  const dir = projectAdapterDir(projectRoot(project, project));
  mkdirSync(dir, { recursive: true });
  const ext = kind === "script" ? "js" : "yaml";
  const path = join(dir, `${id}.${ext}`);
  if (existsSync(path)) {
    process.stderr.write(`already exists: ${path}\n`);
    return 1;
  }
  if (kind === "script") {
    writeFileSync(
      path,
      scriptAdapterSource(id),
    );
  } else {
    writeFileSync(
      path,
      `id: ${id}
name: ${id}
match:
  executable: ${id}
patterns:
  - regex: "progress (\\\\d+)/(\\\\d+)"
    kind: progress
    current: "{1}"
    total: "{2}"
    message: "{1}/{2}"
warnings:
  - regex: "warning: (.+)"
    message: "{1}"
errors:
  - regex: "error: (.+)"
    message: "{1}"
`,
    );
  }
  process.stdout.write(`wrote ${path}\n`);
  return 0;
}

export function parseMaybeYaml(text: string): unknown {
  return parseYaml(text);
}

/** Scaffold body for script adapters. `api` is a QuickJS global, not a hook argument. */
export function scriptAdapterSource(id: string): string {
  return `// flowpeek-match: executable=${id}
// api is injected as a global: phase, progress, activity, metric, warning, error, event, complete, heartbeat
function match(command) {
  return command.executable === ${JSON.stringify(id)};
}
function onStart() {
  api.phase("running");
}
function onLine(line) {
  var m = /progress\\s+(\\d+)\\/(\\d+)/.exec(line);
  if (m) api.progress({ kind: "determinate", current: Number(m[1]), total: Number(m[2]) });
  if (/error/i.test(line)) api.error(line);
  if (/warning/i.test(line)) api.warning(line);
}
function onExit(code) {
  api.complete("exit " + code);
}
`;
}
