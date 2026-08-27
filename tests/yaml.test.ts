import { describe, expect, it } from "vitest";
import { applyPatterns } from "../src/adapters/yaml-engine.js";
import { CARGO_BUILD, NPM_INSTALL, DOCKER_BUILD } from "../src/adapters/builtin.js";
import { commandIdentity, matchesRule } from "../src/adapters/resolve.js";

describe("yaml patterns", () => {
  it("emits cargo compiling activity and does not invent percents", () => {
    const events: Array<{ type: string; progress?: { percent?: number } }> = [];
    applyPatterns(CARGO_BUILD, "   Compiling serde v1.0.0", (p) => events.push(p));
    applyPatterns(CARGO_BUILD, "    Finished `dev` profile [unoptimized + debuginfo] target(s) in 1.23s", (p) =>
      events.push(p),
    );
    expect(events.some((e) => e.type === "activity")).toBe(true);
    expect(events.every((e) => e.progress?.percent == null)).toBe(true);
  });

  it("parses docker Step n/m as determinate progress", () => {
    const events: Array<{ type: string; progress?: { current?: number; total?: number } }> = [];
    applyPatterns(DOCKER_BUILD, "Step 3/12 : RUN echo", (p) => events.push(p));
    const prog = events.find((e) => e.type === "progress");
    expect(prog?.progress?.current).toBe(3);
    expect(prog?.progress?.total).toBe(12);
  });
});

describe("command identity", () => {
  it("matches npm install but not npm test", () => {
    const install = commandIdentity(["npm", "install"], "/tmp");
    const test = commandIdentity(["npm", "test"], "/tmp");
    expect(matchesRule(install, NPM_INSTALL.match)).toBe(true);
    expect(matchesRule(test, NPM_INSTALL.match)).toBe(false);
  });
});
