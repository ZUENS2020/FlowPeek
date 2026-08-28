import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CARGO_BUILD } from "../src/adapters/builtin.js";
import { replayAdapter } from "../src/adapters/engine.js";
import { CompactPrinter, formatDeterminateProgress } from "../src/wrapper/compact.js";
import type { RunEvent } from "../src/types.js";
import { ROOT } from "./helpers.js";

function ev(partial: Partial<RunEvent> & Pick<RunEvent, "type">): RunEvent {
  return {
    runId: "t",
    seq: 1,
    ts: new Date().toISOString(),
    ...partial,
  };
}

describe("formatDeterminateProgress", () => {
  it("does not repeat current/total when message already has it", () => {
    expect(formatDeterminateProgress({ current: 10, total: 10, message: "10/10" })).toBe("10/10");
    expect(formatDeterminateProgress({ current: 3, total: 12, message: "layer 3/12" })).toBe("layer 3/12");
    expect(formatDeterminateProgress({ current: 1, total: 8, message: "compiling" })).toBe("compiling 1/8");
  });
});

describe("compact alert dedupe", () => {
  it("prints a warning once when raw heuristic and adapter event overlap", () => {
    const lines: string[] = [];
    const c = new CompactPrinter("compact", 10, (s) => lines.push(s));
    c.start();
    c.onRaw("warning: disk almost full\n");
    c.onEvent(ev({ type: "warning", message: "warning: disk almost full" }));
    c.onEvent(ev({ type: "warning", message: "disk almost full" }));
    const warnings = lines.filter((l) => l.includes("[warning]"));
    expect(warnings).toHaveLength(1);
  });
});

describe("yaml vs generic warnings", () => {
  it("emits a cargo warning once (adapter pattern, not also generic)", async () => {
    const text = readFileSync(join(ROOT, "fixtures", "cargo-build.txt"), "utf8");
    const r = await replayAdapter({ spec: CARGO_BUILD, source: "builtin" }, text);
    const warns = r.events.filter((e) => e.type === "warning");
    expect(warns).toHaveLength(1);
    expect(warns[0].message).toBe("unused variable: `x`");
  });

  it("generic still reports warnings when no specific adapter matched the line", async () => {
    const r = await replayAdapter(
      { spec: { id: "generic", name: "Generic fallback", kind: "builtin", match: {} }, source: "generic" },
      "warning: demo\n",
    );
    expect(r.events.filter((e) => e.type === "warning")).toHaveLength(1);
  });
});
