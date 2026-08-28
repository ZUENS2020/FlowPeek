import type { SpawnHandle } from "./signals.js";

/** Forward wrapper stdin only when the child is attached to a PTY. */
export function forwardStdinToPty(handle: Pick<SpawnHandle, "pty" | "write">): () => void {
  if (!handle.pty) return () => undefined;
  const stdin = process.stdin;
  if (!stdin || stdin.destroyed || stdin.readableEnded) return () => undefined;

  let rawSet = false;
  if (stdin.isTTY) {
    try {
      stdin.setRawMode(true);
      rawSet = true;
    } catch {
      /* not all TTYs support raw mode */
    }
  }
  const onData = (chunk: string | Buffer) => {
    try {
      handle.write(chunk);
    } catch {
      /* fail open */
    }
  };
  const onError = () => undefined;
  stdin.on("data", onData);
  stdin.on("error", onError);
  if (stdin.isPaused()) stdin.resume();

  return () => {
    stdin.off("data", onData);
    stdin.off("error", onError);
    if (rawSet) {
      try {
        stdin.setRawMode(false);
      } catch {
        /* ignore */
      }
    }
    try {
      stdin.pause();
    } catch {
      /* ignore */
    }
  };
}
