#!/usr/bin/env node
import { chmodSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
try {
  const pkg = dirname(require.resolve("node-pty/package.json"));
  for (const p of [
    join(pkg, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper"),
    join(pkg, "build", "Release", "spawn-helper"),
  ]) {
    if (!existsSync(p)) continue;
    try {
      chmodSync(p, 0o755);
    } catch {
      /* ignore */
    }
  }
} catch {
  /* node-pty not installed yet */
}
