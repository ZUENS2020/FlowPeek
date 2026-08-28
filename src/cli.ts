#!/usr/bin/env node
import { HELP, VERSION } from "./help.js";
import { projectRoot } from "./paths.js";
import type { AgentOutputMode, PtyMode } from "./types.js";

function takeFlag(args: string[], name: string): boolean {
  const i = args.indexOf(name);
  if (i < 0) return false;
  args.splice(i, 1);
  return true;
}

function takeOpt(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
}

function splitCommand(argv: string[]): { flags: string[]; command: string[] } {
  const dd = argv.indexOf("--");
  if (dd >= 0) return { flags: argv.slice(0, dd), command: argv.slice(dd + 1) };
  return { flags: argv, command: [] };
}

async function main(argv: string[]): Promise<number> {
  const rest = argv.slice(2);
  if (rest.length === 0 || rest[0] === "-h" || rest[0] === "--help") {
    process.stdout.write(HELP);
    return 0;
  }
  if (rest[0] === "-V" || rest[0] === "--version" || rest[0] === "version") {
    process.stdout.write(VERSION + "\n");
    return 0;
  }
  const cmd = rest[0];
  const args = rest.slice(1);

  if (cmd === "run") {
    const { runWrapped } = await import("./wrapper/run.js");
    const { flags, command } = splitCommand(args);
    let commandArgs = command;
    if (!commandArgs.length) {
      const nonflag: string[] = [];
      const f: string[] = [];
      for (let i = 0; i < flags.length; i++) {
        const a = flags[i];
        if (
          a === "--label" ||
          a === "--adapter" ||
          a === "--agent-output" ||
          a === "--pty" ||
          a === "--project" ||
          a === "--session" ||
          a === "--agent"
        ) {
          f.push(a, flags[i + 1] || "");
          i++;
        } else if (a.startsWith("-")) {
          f.push(a);
        } else {
          nonflag.push(...flags.slice(i));
          break;
        }
      }
      flags.length = 0;
      flags.push(...f);
      commandArgs = nonflag;
    }
    const noPty = takeFlag(flags, "--no-pty");
    const jsonMeta = takeFlag(flags, "--json-meta");
    const noUrl = takeFlag(flags, "--no-dashboard-url");
    const label = takeOpt(flags, "--label");
    const adapter = takeOpt(flags, "--adapter") || "auto";
    const agentOutput = (takeOpt(flags, "--agent-output") || "passthrough") as AgentOutputMode;
    let pty = (takeOpt(flags, "--pty") || "auto") as PtyMode;
    if (noPty) pty = "never";
    const project = takeOpt(flags, "--project");
    const sessionId = takeOpt(flags, "--session");
    const agentName = takeOpt(flags, "--agent");
    if (agentOutput !== "passthrough" && agentOutput !== "compact") {
      process.stderr.write("invalid --agent-output\n");
      return 2;
    }
    if (pty !== "auto" && pty !== "always" && pty !== "never") {
      process.stderr.write("invalid --pty\n");
      return 2;
    }
    return runWrapped({
      command: commandArgs,
      cwd: projectRoot(process.cwd(), project),
      project,
      sessionId,
      agentName,
      label,
      adapter: adapter as "auto" | "none" | string,
      agentOutput,
      pty,
      jsonMeta,
      noDashboardUrl: noUrl,
    });
  }

  if (cmd === "session-id") {
    const { newSessionId } = await import("./ids.js");
    process.stdout.write(newSessionId() + "\n");
    return 0;
  }

  if (cmd === "daemon") {
    const { startDaemon } = await import("./collector/daemon.js");
    const foreground = takeFlag(args, "--foreground") || takeFlag(args, "-f");
    const project = takeOpt(args, "--project");
    await startDaemon({ foreground, project });
    await new Promise(() => undefined);
    return 0;
  }

  if (cmd === "adapter") {
    const ad = await import("./adapters/cli.js");
    const sub = args[0];
    const restA = args.slice(1);
    const project = takeOpt(restA, "--project") || process.cwd();
    if (sub === "list") return ad.cmdAdapterList(project);
    if (sub === "resolve") {
      const { command } = splitCommand(restA);
      const json = takeFlag(restA, "--json");
      const cmdv = command.length ? command : restA.filter((a) => !a.startsWith("-"));
      return ad.cmdAdapterResolve(cmdv, project, json);
    }
    if (sub === "inspect") {
      const id = restA[0];
      if (!id) {
        process.stderr.write("usage: flowpeek adapter inspect <id>\n");
        return 2;
      }
      return ad.cmdAdapterInspect(id, project);
    }
    if (sub === "validate") return ad.cmdAdapterValidate(restA[0], project);
    if (sub === "test") {
      const json = takeFlag(restA, "--json");
      const report = takeFlag(restA, "--report");
      const fixture = takeOpt(restA, "--fixture");
      const target = restA[0];
      if (!target) {
        process.stderr.write("usage: flowpeek adapter test <id|path> [--fixture file] [--report] [--json]\n");
        return 2;
      }
      return ad.cmdAdapterTest({ target, fixture, json, report, project });
    }
    if (sub === "scaffold") {
      const id = restA[0];
      const kind = (takeOpt(restA, "--kind") || "yaml") as "yaml" | "script";
      if (!id) {
        process.stderr.write("usage: flowpeek adapter scaffold <id> [--kind yaml|script]\n");
        return 2;
      }
      return ad.cmdAdapterScaffold(id, kind, project);
    }
    process.stderr.write("usage: flowpeek adapter list|resolve|inspect|validate|test|scaffold\n");
    return 2;
  }

  if (cmd === "probe") {
    const { runProbe } = await import("./probe.js");
    const { flags, command } = splitCommand(args);
    const maxSeconds = takeOpt(flags, "--max-seconds");
    const maxBytes = takeOpt(flags, "--max-bytes");
    const maxLines = takeOpt(flags, "--max-lines");
    const pty = (takeOpt(flags, "--pty") || "auto") as PtyMode;
    const project = takeOpt(flags, "--project") || process.cwd();
    const json = takeFlag(flags, "--json");
    if (flags.length) {
      process.stderr.write(`unknown probe option: ${flags[0]}\n`);
      return 2;
    }
    if (pty !== "auto" && pty !== "always" && pty !== "never") {
      process.stderr.write("invalid --pty\n");
      return 2;
    }
    return runProbe({
      command,
      project,
      cwd: project,
      pty,
      json,
      maxSeconds,
      maxBytes,
      maxLines,
      env: process.env,
    });
  }

  process.stderr.write(`unknown command: ${cmd}\n${HELP}`);
  return 2;
}

main(process.argv)
  .then((code) => {
    if (typeof code === "number" && !Number.isNaN(code)) process.exit(code);
  })
  .catch((err) => {
    process.stderr.write((err instanceof Error ? err.stack || err.message : String(err)) + "\n");
    process.exit(1);
  });
