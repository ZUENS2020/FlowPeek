import { basename, extname, join } from "node:path";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import type { AdapterSpec, ResolvedAdapter, RunRecord } from "../types.js";
import { projectAdapterDir, userAdapterDir } from "../paths.js";
import { BUILTIN_ADAPTERS } from "./builtin.js";
import { loadConfig } from "../config.js";

export interface CommandIdentity {
  executable: string;
  args: string[];
  cwd: string;
}

export function commandIdentity(command: string[], cwd: string): CommandIdentity {
  const file = command[0] || "";
  const base = basename(file).replace(/\.exe$/i, "").replace(/\.cmd$/i, "");
  return { executable: base, args: command.slice(1), cwd };
}

export function matchesRule(
  identity: CommandIdentity,
  rule: AdapterSpec["match"],
): boolean {
  const rules = Array.isArray(rule) ? rule : [rule];
  return rules.some((r) => matchOne(identity, r));
}

function matchOne(
  identity: CommandIdentity,
  r: {
    executables?: string[];
    executable?: string;
    subcommand?: string;
    subcommands?: string[];
    argsRegex?: string;
  },
): boolean {
  const exes = [
    ...(r.executables || []),
    ...(r.executable ? [r.executable] : []),
  ].map((e) => e.toLowerCase());
  if (exes.length && !exes.includes(identity.executable.toLowerCase())) return false;

  const sub = r.subcommand ? [r.subcommand] : r.subcommands || [];
  if (sub.length) {
    const first = identity.args[0];
    if (!first || !sub.includes(first)) return false;
  }
  if (r.argsRegex) {
    try {
      const re = new RegExp(r.argsRegex);
      if (!re.test(identity.args.join(" "))) return false;
    } catch {
      return false;
    }
  }
  return true;
}

export function parseAdapterFile(path: string): AdapterSpec {
  const ext = extname(path).toLowerCase();
  const raw = readFileSync(path, "utf8");
  if (ext === ".js" || ext === ".mjs") {
    const spec: AdapterSpec = {
      id: basename(path, ext),
      name: basename(path, ext),
      kind: "script",
      match: {},
      script: raw,
    };
    const header = raw.split("\n").slice(0, 30).join("\n");
    const m = header.match(/flowpeek-match:\s*(.+)/);
    if (m) {
      const bits = m[1].trim();
      const exe = bits.match(/executable=(\S+)/);
      const sub = bits.match(/subcommand=(\S+)/);
      spec.match = {
        executable: exe?.[1],
        subcommand: sub?.[1],
      };
    }
    const idm = header.match(/flowpeek-id:\s*(\S+)/);
    if (idm) spec.id = idm[1];
    const namem = header.match(/flowpeek-name:\s*(.+)/);
    if (namem) spec.name = namem[1].trim();
    return spec;
  }
  const doc = parseYaml(raw) as AdapterSpec;
  if (!doc || typeof doc !== "object" || !doc.id) {
    throw new Error(`Invalid adapter file: ${path} (missing id)`);
  }
  doc.kind = doc.script ? "script" : "yaml";
  return doc;
}

function loadDir(dir: string, source: ResolvedAdapter["source"]): ResolvedAdapter[] {
  if (!existsSync(dir)) return [];
  const out: ResolvedAdapter[] = [];
  let files: string[] = [];
  try {
    files = readdirSync(dir);
  } catch {
    return [];
  }
  for (const f of files) {
    if (!/\.(ya?ml|js|mjs)$/i.test(f)) continue;
    const path = join(dir, f);
    try {
      const spec = parseAdapterFile(path);
      out.push({ spec, source, path });
    } catch {
      /* skip invalid */
    }
  }
  return out;
}

export function listAdapters(project: string): ResolvedAdapter[] {
  const cfg = loadConfig({ project, cwd: project });
  const found: ResolvedAdapter[] = [];
  const seen = new Set<string>();
  const add = (items: ResolvedAdapter[]) => {
    for (const a of items) {
      if (seen.has(a.spec.id)) continue;
      seen.add(a.spec.id);
      found.push(a);
    }
  };
  if (cfg.adapters.allow_project) add(loadDir(projectAdapterDir(project), "project"));
  if (cfg.adapters.allow_user) add(loadDir(userAdapterDir(), "user"));
  for (const extra of cfg.adapters.search_paths) add(loadDir(extra, "user"));
  add(
    BUILTIN_ADAPTERS.map((spec) => ({
      spec,
      source: "builtin" as const,
    })),
  );
  add([
    {
      spec: {
        id: "generic",
        name: "Generic fallback",
        kind: "builtin",
        match: {},
      },
      source: "generic",
    },
  ]);
  return found;
}

export function resolveAdapter(
  command: string[],
  cwd: string,
  project: string,
  requested: "auto" | "none" | string,
): ResolvedAdapter {
  if (requested === "none") {
    return {
      spec: { id: "none", name: "None", kind: "builtin", match: {} },
      source: "generic",
    };
  }
  const all = listAdapters(project);
  if (requested !== "auto") {
    const found = all.find((a) => a.spec.id === requested);
    if (found) return found;
    return {
      spec: { id: "generic", name: "Generic fallback", kind: "builtin", match: {} },
      source: "generic",
    };
  }
  const identity = commandIdentity(command, cwd);
  for (const a of all) {
    if (a.spec.id === "generic" || a.spec.id === "none") continue;
    if (matchesRule(identity, a.spec.match)) return a;
  }
  return all.find((a) => a.spec.id === "generic")!;
}

export function inspectAdapter(id: string, project: string): ResolvedAdapter | undefined {
  return listAdapters(project).find((a) => a.spec.id === id);
}

export function adapterForRun(
  run: Pick<RunRecord, "command" | "cwd" | "adapterId">,
  project: string,
): ResolvedAdapter {
  const req = run.adapterId && run.adapterId !== "auto" ? run.adapterId : "auto";
  return resolveAdapter(run.command, run.cwd, project, req as "auto" | "none" | string);
}
