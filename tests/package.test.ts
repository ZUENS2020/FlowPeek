import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT } from "./helpers.js";

describe("published package", () => {
  it("ships the script required by postinstall", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    expect(pkg.scripts.postinstall).toBe("node scripts/ensure-pty-helper.js");
    expect(pkg.files).toContain("scripts/ensure-pty-helper.js");
    expect(existsSync(join(ROOT, "scripts", "ensure-pty-helper.js"))).toBe(true);
  });
});
