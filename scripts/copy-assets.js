import { cpSync, mkdirSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dest = join(root, "dist", "dashboard", "public");
mkdirSync(dest, { recursive: true });
cpSync(join(root, "src", "dashboard", "public"), dest, { recursive: true });

try {
  chmodSync(join(root, "dist", "cli.js"), 0o755);
} catch {
  // Windows or not yet emitted
}
