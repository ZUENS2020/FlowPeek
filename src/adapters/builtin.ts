import type { AdapterPattern, AdapterSpec } from "../types.js";

export const NPM_INSTALL: AdapterSpec = {
  id: "npm-install",
  name: "npm / pnpm / yarn install",
  kind: "yaml",
  match: [
    { executables: ["npm", "npm.cmd"], subcommands: ["install", "i", "ci"] },
    { executables: ["pnpm", "pnpm.cmd"], subcommands: ["install", "i"] },
    { executables: ["yarn", "yarn.cmd"], subcommands: ["install"] },
  ],
  patterns: [
    { regex: "added (\\d+) packages?", kind: "activity", message: "added {1} packages" },
    { regex: "removed (\\d+) packages?", kind: "activity", message: "removed {1} packages" },
    { regex: "Packages: +(\\S+)", kind: "activity", message: "packages {1}" },
    { regex: "Done in ([0-9.s]+)", kind: "complete", message: "done in {1}" },
    { regex: "audited (\\d+) packages", kind: "metric", name: "audited", value: "{1}" },
  ],
  warnings: [{ regex: "npm warn (.*)", message: "{1}" }, { regex: "WARN\\s+(.*)", message: "{1}" }],
  errors: [{ regex: "npm ERR! (.*)", message: "{1}" }, { regex: "ERROR\\s+(.*)", message: "{1}" }],
  complete: [{ regex: "added \\d+ packages", message: "install finished" }],
};

export const CARGO_BUILD: AdapterSpec = {
  id: "cargo-build",
  name: "Cargo build",
  kind: "yaml",
  match: { executable: "cargo", subcommands: ["build", "check", "clippy"] },
  patterns: [
    { regex: "Compiling (\\S+)", kind: "activity", message: "Compiling {1}" },
    { regex: "Checking (\\S+)", kind: "activity", message: "Checking {1}" },
    { regex: "Finished `.+` profile", kind: "phase", phase: "finished" },
    {
      regex: "Finished `.+` profile \\[.+\\] target\\(s\\) in (.+)",
      kind: "complete",
      message: "Finished in {1}",
    },
  ],
  warnings: [{ regex: "^warning: (.+)$", message: "{1}" }],
  errors: [{ regex: "^error(?:\\[E\\d+\\])?: (.+)$", message: "{1}" }],
};

export const PYTEST: AdapterSpec = {
  id: "pytest",
  name: "pytest",
  kind: "yaml",
  match: [
    { executable: "pytest" },
    { executable: "python", argsRegex: "-m\\s+pytest" },
    { executable: "python3", argsRegex: "-m\\s+pytest" },
  ],
  patterns: [
    { regex: "=+ test session starts =+", kind: "phase", phase: "session" },
    { regex: "collected (\\d+) items?", kind: "metric", name: "collected", value: "{1}" },
    { regex: "PASSED", kind: "activity", message: "passed" },
    { regex: "FAILED", kind: "activity", message: "failed" },
    {
      regex: "=+ (\\d+) passed.*in ([0-9.]+)s",
      kind: "complete",
      message: "{1} passed in {2}s",
    },
  ],
  warnings: [{ regex: "warnings? summary", message: "warnings summary" }],
  errors: [
    { regex: "FAILED (.+)", message: "{1}" },
    { regex: "ERROR (.+)", message: "{1}" },
  ],
};

export const FFMPEG: AdapterSpec = {
  id: "ffmpeg",
  name: "ffmpeg",
  kind: "yaml",
  match: { executable: "ffmpeg" },
  patterns: [
    { regex: "Duration: (\\d+:\\d+:\\d+\\.\\d+)", kind: "metric", name: "duration", unit: "timecode" },
    {
      regex: "frame=\\s*(\\d+).*time=(\\S+).*speed=\\s*(\\S+)",
      kind: "activity",
      message: "frame {1} time={2} speed={3}",
    },
    { regex: "time=(\\S+)", kind: "activity", message: "time {1}" },
  ],
  warnings: [{ regex: "deprecated", message: "deprecated option" }],
  errors: [{ regex: "Error (.+)", message: "{1}" }, { regex: "Invalid (.+)", message: "{1}" }],
};

export const DOCKER_BUILD: AdapterSpec = {
  id: "docker-build",
  name: "Docker build",
  kind: "yaml",
  match: [
    { executable: "docker", subcommands: ["build"] },
    { executable: "docker", argsRegex: "^buildx\\s+build" },
    { executable: "podman", subcommands: ["build"] },
  ],
  patterns: [
    {
      regex: "Step (\\d+)/(\\d+)",
      kind: "progress",
      current: "{1}",
      total: "{2}",
      message: "step {1}/{2}",
    },
    {
      regex: "#\\d+\\s+\\[(\\d+)/(\\d+)\\]",
      kind: "progress",
      current: "{1}",
      total: "{2}",
      message: "layer {1}/{2}",
    },
    { regex: "naming to (\\S+)", kind: "activity", message: "naming {1}" },
    { regex: "exporting to image", kind: "phase", phase: "export" },
  ],
  warnings: [{ regex: "WARNING: (.+)", message: "{1}" }],
  errors: [{ regex: "ERROR: (.+)", message: "{1}" }],
};

export const BUILTIN_ADAPTERS: AdapterSpec[] = [
  NPM_INSTALL,
  CARGO_BUILD,
  PYTEST,
  FFMPEG,
  DOCKER_BUILD,
];

export function builtinById(id: string): AdapterSpec | undefined {
  return BUILTIN_ADAPTERS.find((a) => a.id === id);
}

export function yamlFromSpec(spec: AdapterSpec): string {
  const { kind, script, ...rest } = spec;
  void kind;
  void script;
  const lines: string[] = [];
  lines.push(`id: ${rest.id}`);
  lines.push(`name: ${JSON.stringify(rest.name)}`);
  lines.push(`match:`);
  const dumpRule = (r: AdapterSpec["match"], indent: string) => {
    const rules = Array.isArray(r) ? r : [r];
    if (rules.length > 1) {
      for (const rule of rules) {
        lines.push(`${indent}- ${formatInline(rule)}`);
      }
    } else {
      const rule = rules[0];
      for (const [k, v] of Object.entries(rule)) {
        lines.push(`${indent}  ${k}: ${JSON.stringify(v)}`);
      }
    }
  };
  dumpRule(rest.match, "");
  const dumpPatterns = (key: string, pats?: AdapterPattern[]) => {
    if (!pats?.length) return;
    lines.push(`${key}:`);
    for (const p of pats) {
      lines.push(`  - regex: ${JSON.stringify(p.regex)}`);
      for (const [k, v] of Object.entries(p)) {
        if (k === "regex" || v === undefined) continue;
        lines.push(`    ${k}: ${JSON.stringify(v)}`);
      }
    }
  };
  dumpPatterns("patterns", rest.patterns);
  dumpPatterns("warnings", rest.warnings);
  dumpPatterns("errors", rest.errors);
  dumpPatterns("complete", rest.complete);
  return lines.join("\n") + "\n";
}

function formatInline(obj: object): string {
  return Object.entries(obj)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join(" ");
}
