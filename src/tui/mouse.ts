export const ENABLE_MOUSE = "\x1b[?1000h\x1b[?1006h";
export const DISABLE_MOUSE = "\x1b[?1000l\x1b[?1006l";

export interface TuiMouseEvent {
  code: number;
  x: number;
  y: number;
  release: boolean;
  kind: "left" | "wheel-up" | "wheel-down" | "other";
}

/** Parse xterm SGR mouse reports. Unknown buttons are retained but ignored. */
export function parseSgrMouse(input: string): TuiMouseEvent[] {
  const events: TuiMouseEvent[] = [];
  const pattern = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
  for (const match of input.matchAll(pattern)) {
    const code = Number(match[1]);
    const x = Number(match[2]);
    const y = Number(match[3]);
    if (!Number.isInteger(code) || !Number.isInteger(x) || !Number.isInteger(y) || x < 1 || y < 1) continue;
    const wheel = (code & 64) !== 0;
    const button = code & 3;
    events.push({
      code,
      x,
      y,
      release: match[4] === "m",
      kind: wheel ? (button === 0 ? "wheel-up" : button === 1 ? "wheel-down" : "other") : button === 0 ? "left" : "other",
    });
  }
  return events;
}
