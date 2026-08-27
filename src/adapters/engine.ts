import type { ResolvedAdapter, RunEvent } from "../types.js";
import { nowIso } from "../ids.js";
import {
  genericHeartbeat,
  genericOnChunk,
  genericOnExit,
  genericOnLine,
  genericOnStart,
  newGenericState,
  type GenericState,
} from "./generic.js";
import { ScriptSandbox } from "./sandbox.js";
import { applyPatterns, splitLinesPreserveCR, stripAnsi, type EmitFn } from "./yaml-engine.js";

export class AdapterSession {
  private seq = 0;
  private pending = "";
  private generic: GenericState = newGenericState();
  private sandbox: ScriptSandbox | null = null;
  disabled = false;
  disableReason = "";
  private ready: Promise<void>;
  private hbTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly runId: string,
    private readonly resolved: ResolvedAdapter,
    private readonly out: (ev: RunEvent) => void,
    private readonly onDisable?: (reason: string) => void,
  ) {
    const emit: EmitFn = (partial) => this.emit(partial);
    this.ready = this.setup(emit);
  }

  private async setup(emit: EmitFn): Promise<void> {
    genericOnStart(emit);
    const spec = this.resolved.spec;
    if (spec.kind === "script" && spec.script && spec.id !== "none") {
      this.sandbox = new ScriptSandbox();
      try {
        await this.sandbox.init(spec.script, emit);
        if (this.sandbox.disabled) this.disable(this.sandbox.disableReason);
        else this.sandbox.call("onStart", {});
      } catch (err) {
        this.disable(err instanceof Error ? err.message : String(err));
      }
    }
    this.hbTimer = setInterval(() => {
      if (this.disabled && this.resolved.spec.id !== "generic") {
        genericHeartbeat(this.generic, (p) => this.emit(p));
        return;
      }
      genericHeartbeat(this.generic, (p) => this.emit(p));
      try {
        this.sandbox?.call("heartbeat");
      } catch {
        /* ignore */
      }
    }, 5000);
    this.hbTimer.unref?.();
  }

  async onChunk(chunk: string): Promise<void> {
    await this.ready;
    const emit: EmitFn = (partial) => this.emit(partial);
    try {
      genericOnChunk(this.generic, chunk, emit);
    } catch {
      /* generic must never fail the run */
    }
    if (!this.disabled && this.sandbox?.hooks.onChunk) {
      try {
        this.sandbox.call("onChunk", chunk);
        if (this.sandbox.disabled) this.disable(this.sandbox.disableReason);
      } catch (err) {
        this.disable(err instanceof Error ? err.message : String(err));
      }
    }
    const { lines, pending } = splitLinesPreserveCR(chunk, this.pending);
    this.pending = pending;
    for (const line of lines) this.onLine(stripAnsi(line));
  }

  onLine(line: string): void {
    const emit: EmitFn = (partial) => this.emit(partial);
    try {
      genericOnLine(this.generic, line, emit);
    } catch {
      /* ignore */
    }
    if (this.disabled) return;
    const spec = this.resolved.spec;
    if (spec.kind !== "script" && spec.id !== "none" && spec.id !== "generic") {
      try {
        applyPatterns(spec, line, emit);
      } catch (err) {
        this.disable(err instanceof Error ? err.message : String(err));
      }
    }
    if (this.sandbox?.hooks.onLine) {
      try {
        this.sandbox.call("onLine", line);
        if (this.sandbox.disabled) this.disable(this.sandbox.disableReason);
      } catch (err) {
        this.disable(err instanceof Error ? err.message : String(err));
      }
    }
  }

  async onExit(code: number | null, signal: string | null): Promise<void> {
    await this.ready;
    const emit: EmitFn = (partial) => this.emit(partial);
    genericOnExit(code, signal, emit);
    if (!this.disabled && this.sandbox?.hooks.onExit) {
      try {
        this.sandbox.call("onExit", code);
      } catch (err) {
        this.disable(err instanceof Error ? err.message : String(err));
      }
    }
    this.dispose();
  }

  private emit(partial: Omit<RunEvent, "runId" | "seq" | "ts"> & { ts?: string }): void {
    this.seq += 1;
    this.out({
      runId: this.runId,
      seq: this.seq,
      ts: partial.ts || nowIso(),
      ...partial,
    });
  }

  private disable(reason: string): void {
    if (this.disabled) return;
    this.disabled = true;
    this.disableReason = reason;
    this.sandbox?.disable(reason);
    this.emit({
      type: "warning",
      message: `adapter ${this.resolved.spec.id} disabled: ${reason}; falling back to raw log + generic`,
    });
    this.onDisable?.(reason);
  }

  dispose(): void {
    if (this.hbTimer) clearInterval(this.hbTimer);
    this.sandbox?.dispose();
  }
}

export async function replayAdapter(
  resolved: ResolvedAdapter,
  text: string,
): Promise<{ events: RunEvent[]; disabled: boolean; reason: string }> {
  const events: RunEvent[] = [];
  const session = new AdapterSession("test", resolved, (ev) => {
    if (ev.type !== "raw") events.push(ev);
  });
  await session.onChunk(text);
  await session.onExit(0, null);
  return { events, disabled: session.disabled, reason: session.disableReason };
}
