import { EventEmitter } from "node:events";
import type { IpcDownlink, IpcMessage } from "../types.js";

const MAX_QUEUE_BYTES = 4 * 1024 * 1024;

interface Queued {
  line: string;
  bytes: number;
  raw: boolean;
}

/**
 * Bounded, fail-open telemetry queue.
 * Raw chunks are dropped on overflow; structured messages are kept.
 * Never throws; never awaits the caller.
 */
export class TelemetryQueue extends EventEmitter {
  private items: Queued[] = [];
  private bytes = 0;
  droppedChunks = 0;
  droppedBytes = 0;
  private flushing = false;

  constructor(private readonly maxBytes = MAX_QUEUE_BYTES) {
    super();
  }

  push(msg: IpcMessage, raw = false): void {
    let line: string;
    try {
      line = JSON.stringify(msg) + "\n";
    } catch {
      this.droppedChunks++;
      return;
    }
    const n = Buffer.byteLength(line);
    if (raw && this.bytes + n > this.maxBytes) {
      this.droppedChunks++;
      this.droppedBytes += n;
      this.emit("drop", this.droppedChunks);
      return;
    }
    if (!raw && this.bytes + n > this.maxBytes) {
      this.evictRaw(n);
    }
    if (this.bytes + n > this.maxBytes) {
      this.droppedChunks++;
      this.droppedBytes += n;
      this.emit("drop", this.droppedChunks);
      return;
    }
    this.items.push({ line, bytes: n, raw });
    this.bytes += n;
    this.emit("queued");
  }

  private evictRaw(need: number): void {
    const kept: Queued[] = [];
    for (const item of this.items) {
      if (item.raw && this.bytes + need > this.maxBytes) {
        this.bytes -= item.bytes;
        this.droppedChunks++;
        this.droppedBytes += item.bytes;
        continue;
      }
      kept.push(item);
    }
    this.items = kept;
  }

  shift(): Queued | undefined {
    const item = this.items.shift();
    if (item) this.bytes -= item.bytes;
    return item;
  }

  drain(): string[] {
    const out = this.items.map((i) => i.line);
    this.items = [];
    this.bytes = 0;
    return out;
  }

  get size(): number {
    return this.bytes;
  }

  get pending(): number {
    return this.items.length;
  }

  markFlushing(v: boolean): void {
    this.flushing = v;
  }

  get isFlushing(): boolean {
    return this.flushing;
  }
}

export type DownlinkHandler = (msg: IpcDownlink) => void;
