const MAX_PENDING_ESCAPE = 8192;

/**
 * Small, bounded terminal-text buffer for the TUI log pane. It applies the
 * cursor behavior FlowPeek needs for progress output while discarding terminal
 * control sequences so observed commands cannot take control of the TUI.
 */
export class TerminalBuffer {
  private readonly lines: string[] = [""];
  private col = 0;
  private pendingEscape = "";

  constructor(
    private readonly maxLines = 1200,
    private readonly maxColumns = 16_384,
  ) {}

  write(chunk: string): void {
    const text = this.pendingEscape + chunk;
    this.pendingEscape = "";
    let i = 0;
    while (i < text.length) {
      const code = text.charCodeAt(i);
      if (code === 0x1b) {
        const length = escapeSequenceLength(text, i);
        if (length === 0) {
          const rest = text.slice(i);
          this.pendingEscape = rest.length <= MAX_PENDING_ESCAPE ? rest : "";
          break;
        }
        i += length;
        continue;
      }
      if (code === 0x0d) {
        if (text.charCodeAt(i + 1) === 0x0a) {
          this.newline();
          i += 2;
        } else {
          this.col = 0;
          i++;
        }
        continue;
      }
      if (code === 0x0a) {
        this.newline();
        i++;
        continue;
      }
      if (code === 0x08) {
        this.col = Math.max(0, this.col - 1);
        i++;
        continue;
      }
      if (code === 0x09) {
        const spaces = 8 - (this.col % 8);
        for (let n = 0; n < spaces; n++) this.put(" ");
        i++;
        continue;
      }
      if (code < 0x20 || code === 0x7f) {
        i++;
        continue;
      }
      this.put(text[i]);
      i++;
    }
  }

  tail(limit: number): string[] {
    if (limit <= 0) return [];
    return this.lines.slice(-limit);
  }

  text(): string {
    return this.lines.join("\n");
  }

  private put(char: string): void {
    if (this.col >= this.maxColumns) return;
    const index = this.lines.length - 1;
    let line = this.lines[index];
    if (this.col > line.length) line += " ".repeat(this.col - line.length);
    if (this.col === line.length) this.lines[index] = line + char;
    else this.lines[index] = line.slice(0, this.col) + char + line.slice(this.col + 1);
    this.col++;
  }

  private newline(): void {
    this.lines.push("");
    this.col = 0;
    if (this.lines.length > this.maxLines) {
      this.lines.splice(0, this.lines.length - this.maxLines);
    }
  }
}

function escapeSequenceLength(text: string, start: number): number {
  if (start + 1 >= text.length) return 0;
  const kind = text[start + 1];
  if (kind === "[") {
    for (let i = start + 2; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code >= 0x40 && code <= 0x7e) return i - start + 1;
    }
    return 0;
  }
  if (kind === "]" || kind === "P" || kind === "_" || kind === "^") {
    for (let i = start + 2; i < text.length; i++) {
      if (kind === "]" && text.charCodeAt(i) === 0x07) return i - start + 1;
      if (text.charCodeAt(i) === 0x1b && text[i + 1] === "\\") return i - start + 2;
    }
    return 0;
  }
  return 2;
}

export function sanitizeInline(value: unknown): string {
  const buffer = new TerminalBuffer(1, 16_384);
  buffer.write(String(value ?? "").replace(/[\r\n]+/g, " "));
  return buffer.text();
}
