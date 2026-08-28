import { randomBytes } from "node:crypto";

export function newRunId(): string {
  const t = Date.now().toString(36);
  const r = randomBytes(5).toString("hex");
  return `r${t}${r}`;
}

export function newSessionId(): string {
  const t = Date.now().toString(36);
  const r = randomBytes(5).toString("hex");
  return `s${t}${r}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}
