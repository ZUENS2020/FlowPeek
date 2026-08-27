import { getQuickJS, type QuickJSContext, type QuickJSRuntime, type QuickJSWASMModule } from "quickjs-emscripten";
import type { EmitFn } from "./yaml-engine.js";

const MAX_CPU_MS = 20;
const MAX_MEMORY = 32 * 1024 * 1024;

let modPromise: Promise<QuickJSWASMModule> | null = null;

function wasm(): Promise<QuickJSWASMModule> {
  if (!modPromise) modPromise = getQuickJS();
  return modPromise;
}

export class AdapterDisabledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdapterDisabledError";
  }
}

export interface ScriptHooks {
  match?: boolean;
  onStart: boolean;
  onChunk: boolean;
  onLine: boolean;
  onExit: boolean;
}

/**
 * Isolated QuickJS runtime for user/project script adapters.
 * No Node builtins, no filesystem, no network, no child_process.
 *
 * `api` is injected as a global. Hooks are called with data arguments only:
 *   onStart()
 *   onChunk(chunk)
 *   onLine(line)
 *   onExit(code, signal)
 */
export class ScriptSandbox {
  private runtime: QuickJSRuntime | null = null;
  private ctx: QuickJSContext | null = null;
  private startMs = 0;
  private handles: Array<{ dispose(): void }> = [];
  disabled = false;
  disableReason = "";
  hooks: ScriptHooks = { onStart: false, onChunk: false, onLine: false, onExit: false };

  async init(script: string, emit: EmitFn): Promise<void> {
    const Q = await wasm();
    this.runtime = Q.newRuntime();
    this.runtime.setMemoryLimit(MAX_MEMORY);
    this.ctx = this.runtime.newContext();
    this.injectApi(emit);
    this.startMs = Date.now();
    this.runtime.setInterruptHandler(() => Date.now() - this.startMs > MAX_CPU_MS);
    const result = this.ctx.evalCode(script);
    if (result.error) {
      const msg = this.dump(result.error);
      result.error.dispose();
      this.disable(`script eval failed: ${msg}`);
      return;
    }
    result.value.dispose();
    this.hooks = {
      onStart: this.hasFn("onStart"),
      onChunk: this.hasFn("onChunk"),
      onLine: this.hasFn("onLine"),
      onExit: this.hasFn("onExit"),
      match: this.hasFn("match"),
    };
  }

  private hasFn(name: string): boolean {
    if (!this.ctx) return false;
    const v = this.ctx.getProp(this.ctx.global, name);
    const ok = this.ctx.typeof(v) === "function";
    v.dispose();
    return ok;
  }

  private injectApi(emit: EmitFn): void {
    const ctx = this.ctx!;
    const api = ctx.newObject();
    const bind = (name: string, fn: (...args: unknown[]) => void) => {
      const handle = ctx.newFunction(name, (...handles) => {
        const args = handles.map((h) => ctx.dump(h));
        try {
          fn(...args);
        } catch {
          /* adapter API must not throw into user script */
        }
        return ctx.undefined;
      });
      ctx.setProp(api, name, handle);
      this.handles.push(handle);
    };
    bind("phase", (phase) => emit({ type: "phase", phase: String(phase ?? ""), message: String(phase ?? "") }));
    bind("progress", (payload) => {
      const p = (payload && typeof payload === "object" ? payload : { message: String(payload) }) as {
        kind?: string;
        current?: number;
        total?: number;
        percent?: number;
        message?: string;
        unit?: string;
      };
      if (p.percent != null && (p.total == null || !p.total) && p.kind === "determinate") {
        // Refuse invented determinate percentages without a total.
        delete p.percent;
        p.kind = "activity";
      }
      emit({
        type: "progress",
        progress: {
          kind: (p.kind as "determinate") || (p.total ? "determinate" : "activity"),
          current: p.current,
          total: p.total,
          percent: p.total && p.current != null ? (p.current / p.total) * 100 : undefined,
          message: p.message,
          unit: p.unit,
        },
        message: p.message,
      });
    });
    bind("activity", (msg) => emit({ type: "activity", activity: String(msg ?? ""), message: String(msg ?? "") }));
    bind("metric", (name, value, unit) =>
      emit({
        type: "metric",
        metric: { name: String(name ?? "metric"), value: Number(value) || 0, unit: unit ? String(unit) : undefined },
      }),
    );
    bind("warning", (msg) => emit({ type: "warning", message: String(msg ?? "") }));
    bind("error", (msg) => emit({ type: "error", message: String(msg ?? "") }));
    bind("event", (ev) => {
      const e = ev && typeof ev === "object" ? (ev as Record<string, unknown>) : { message: String(ev) };
      const type = String(e.type || "activity") as "activity";
      emit({ type, message: e.message ? String(e.message) : undefined, activity: e.message ? String(e.message) : undefined });
    });
    bind("complete", (msg) => emit({ type: "phase", phase: "complete", message: String(msg ?? "complete") }));
    bind("heartbeat", (msg) => emit({ type: "heartbeat", message: String(msg ?? "heartbeat") }));
    ctx.setProp(ctx.global, "api", api);
    this.handles.push(api);
  }

  call(name: string, ...args: unknown[]): void {
    if (this.disabled || !this.ctx) return;
    this.startMs = Date.now();
    const fn = this.ctx.getProp(this.ctx.global, name);
    if (this.ctx.typeof(fn) !== "function") {
      fn.dispose();
      return;
    }
    const handles = args.map((a) => this.ctx!.unwrapResult(this.ctx!.evalCode("(" + JSON.stringify(a) + ")")));
    try {
      const result = this.ctx.callFunction(fn, this.ctx.undefined, ...handles);
      if (result.error) {
        const msg = this.dump(result.error);
        result.error.dispose();
        this.disabled = true;
        this.disableReason = `${name} threw: ${msg}`;
      } else {
        result.value.dispose();
      }
    } catch (err) {
      this.disabled = true;
      this.disableReason = `${name} failed: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      try {
        fn.dispose();
      } catch {
        /* ignore */
      }
      for (const h of handles) {
        try {
          h.dispose();
        } catch {
          /* ignore */
        }
      }
    }
    if (this.disabled) return;
  }

  private dump(handle: { alive: boolean }): string {
    try {
      return String(this.ctx?.dump(handle as never) ?? "error");
    } catch {
      return "error";
    }
  }

  disable(reason: string): void {
    this.disabled = true;
    this.disableReason = reason;
  }

  dispose(): void {
    for (const h of this.handles) {
      try {
        h.dispose();
      } catch {
        /* ignore */
      }
    }
    this.handles = [];
    try {
      this.ctx?.dispose();
    } catch {
      /* ignore */
    }
    try {
      this.runtime?.dispose();
    } catch {
      /* ignore */
    }
    this.ctx = null;
    this.runtime = null;
  }
}
