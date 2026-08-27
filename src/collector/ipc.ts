import net from "node:net";
import { existsSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { daemonSockPath } from "../paths.js";
import type { IpcDownlink, IpcMessage } from "../types.js";
import type { RunRegistry } from "./registry.js";

export function startIpcServer(registry: RunRegistry, project: string): Promise<net.Server> {
  const path = daemonSockPath();
  if (process.platform !== "win32") {
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path)) {
      try {
        unlinkSync(path);
      } catch {
        /* ignore */
      }
    }
  }
  const sockets = new Map<net.Socket, { runId?: string; buf: string }>();

  const server = net.createServer((sock) => {
    const state = { runId: undefined as string | undefined, buf: "" };
    sockets.set(sock, state);
    sock.setNoDelay(true);
    sock.on("data", (buf) => {
      state.buf += buf.toString("utf8");
      let idx: number;
      while ((idx = state.buf.indexOf("\n")) >= 0) {
        const line = state.buf.slice(0, idx);
        state.buf = state.buf.slice(idx + 1);
        handleLine(line, sock, state, registry, project);
      }
    });
    sock.on("error", () => {
      /* fail open */
    });
    sock.on("close", () => {
      sockets.delete(sock);
      if (state.runId) {
        const live = registry.live.get(state.runId);
        if (live && live.run.processState !== "exited") {
          registry.markTelemetryLost(state.runId);
        }
      }
    });
  });

  registry.on("downlink", (runId: string, msg: IpcDownlink) => {
    const line = JSON.stringify(msg) + "\n";
    for (const [sock, st] of sockets) {
      if (st.runId === runId) {
        try {
          sock.write(line);
        } catch {
          /* ignore */
        }
      }
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => resolve(server));
  });
}

function handleLine(
  line: string,
  _sock: net.Socket,
  state: { runId?: string; buf: string },
  registry: RunRegistry,
  project: string,
): void {
  const t = line.trim();
  if (!t) return;
  let msg: IpcMessage;
  try {
    msg = JSON.parse(t) as IpcMessage;
  } catch {
    return;
  }
  try {
    switch (msg.t) {
      case "hello":
        state.runId = msg.run.id;
        if (!registry.live.has(msg.run.id)) registry.startRun(msg.run, msg.run.cwd || project);
        else registry.markTelemetryRestored(msg.run.id);
        break;
      case "raw":
        state.runId = msg.id;
        registry.ingestRaw(msg.id, msg.d, msg.n, msg.s);
        break;
      case "hb":
        registry.heartbeat(msg.id, msg.dropped);
        break;
      case "drop":
        registry.markDropped(msg.id, msg.dropped);
        break;
      case "exit":
        registry.exit(msg.id, msg.code, msg.signal, msg.endedAt);
        break;
      case "bye":
        break;
      default:
        break;
    }
  } catch {
    /* collector must never throw into the socket handler in a way that kills the daemon */
  }
}
