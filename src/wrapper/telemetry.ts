import net from "node:net";
import { TelemetryQueue } from "./queue.js";
import type { IpcDownlink, IpcMessage, RunRecord } from "../types.js";
import { daemonSockPath } from "../paths.js";
import { nowIso } from "../ids.js";

const RECONNECT_MS = 750;

/**
 * Fire-and-forget Unix-socket (or named-pipe) client.
 * Socket backpressure, disconnects, and parse errors never throw to the caller.
 */
export class TelemetryClient {
  readonly queue = new TelemetryQueue();
  connected = false;
  private socket: net.Socket | null = null;
  private closed = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private rawSeq = 0;
  private buf = "";
  onDownlink: ((msg: IpcDownlink) => void) | null = null;
  private run: RunRecord | null = null;
  private sockPath: string;
  private awaitingDrain = false;

  constructor(sockPath = daemonSockPath()) {
    this.sockPath = sockPath;
    this.queue.on("queued", () => this.flush());
  }

  attach(run: RunRecord): void {
    this.run = run;
    this.connect();
    this.send({ t: "hello", run }, false);
  }

  sendRaw(chunk: Buffer | string): void {
    const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    if (buf.length === 0) return;
    this.rawSeq += 1;
    this.send(
      {
        t: "raw",
        id: this.run?.id || "",
        s: this.rawSeq,
        d: buf.toString("base64"),
        n: buf.length,
      },
      true,
    );
  }

  send(msg: IpcMessage, raw: boolean): void {
    this.queue.push(msg, raw);
    this.flush();
  }

  heartbeat(): void {
    if (!this.run) return;
    this.send(
      {
        t: "hb",
        id: this.run.id,
        ts: nowIso(),
        dropped: this.queue.droppedChunks,
      },
      false,
    );
    if (this.queue.droppedChunks > 0) {
      this.send({ t: "drop", id: this.run.id, dropped: this.queue.droppedChunks }, false);
    }
  }

  exit(code: number | null, signal: string | null): void {
    if (!this.run) return;
    this.send(
      { t: "exit", id: this.run.id, code, signal, endedAt: nowIso() },
      false,
    );
    this.send({ t: "bye", id: this.run.id }, false);
    this.flush(true);
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    try {
      this.socket?.end();
    } catch {
      /* ignore */
    }
    this.socket = null;
    this.connected = false;
  }

  private connect(): void {
    if (this.closed || this.socket) return;
    let sock: net.Socket;
    try {
      sock = net.connect(this.sockPath);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = sock;
    sock.setNoDelay(true);
    sock.on("connect", () => {
      this.connected = true;
      if (this.run) this.send({ t: "hello", run: this.run }, false);
      this.flush();
    });
    sock.on("data", (data) => this.onData(data));
    sock.on("error", () => this.onDisconnect());
    sock.on("close", () => this.onDisconnect());
    sock.on("drain", () => {
      this.awaitingDrain = false;
      this.flush();
    });
  }

  private onData(data: Buffer): void {
    this.buf += data.toString("utf8");
    let idx: number;
    while ((idx = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as IpcDownlink;
        this.onDownlink?.(msg);
      } catch {
        /* ignore malformed downlink */
      }
    }
  }

  private onDisconnect(): void {
    this.connected = false;
    this.awaitingDrain = false;
    try {
      this.socket?.destroy();
    } catch {
      /* ignore */
    }
    this.socket = null;
    if (!this.closed) this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, RECONNECT_MS);
    this.reconnectTimer.unref?.();
  }

  private flush(_force = false): void {
    if (!this.socket || !this.connected || this.awaitingDrain) return;
    if (this.queue.isFlushing) return;
    this.queue.markFlushing(true);
    try {
      while (this.queue.pending > 0) {
        const item = this.queue.shift();
        if (!item) break;
        const ok = this.socket.write(item.line);
        if (!ok) {
          this.awaitingDrain = true;
          break;
        }
      }
    } catch {
      this.connected = false;
    } finally {
      this.queue.markFlushing(false);
    }
  }
}
