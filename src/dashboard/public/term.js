/** Rolling VT-ish buffer: CR returns to column 0 and overwrites; it does not erase. */

export class TermBuf {
  constructor(maxLines = 1800) {
    this.maxLines = maxLines;
    this.lines = [""];
    this.col = 0;
  }

  write(text) {
    let i = 0;
    while (i < text.length) {
      const ch = text[i];
      if (ch === "\x1b") {
        const rest = text.slice(i);
        const m =
          rest.match(/^\x1b\[[0-9;?]*[ -/]*[@-~]/) ||
          rest.match(/^\x1b\][^\x07]*\x07/) ||
          rest.match(/^\x1b./);
        if (m) {
          const seq = m[0];
          if (/^\x1b\[2K/.test(seq)) this.eraseFullLine();
          else if (/^\x1b\[1K/.test(seq)) this.eraseToCursor();
          else if (/^\x1b\[(?:0?K)/.test(seq)) this.eraseToEnd();
          i += seq.length;
          continue;
        }
      }
      if (ch === "\r") {
        if (text[i + 1] === "\n") {
          this.newline();
          i += 2;
          continue;
        }
        this.col = 0;
        i++;
        continue;
      }
      if (ch === "\n") {
        this.newline();
        i++;
        continue;
      }
      this.put(ch);
      i++;
    }
  }

  put(ch) {
    const idx = this.lines.length - 1;
    let line = this.lines[idx];
    if (this.col > line.length) line += " ".repeat(this.col - line.length);
    if (this.col === line.length) this.lines[idx] = line + ch;
    else this.lines[idx] = line.slice(0, this.col) + ch + line.slice(this.col + 1);
    this.col++;
  }

  newline() {
    this.lines.push("");
    this.col = 0;
    if (this.lines.length > this.maxLines) {
      this.lines.splice(0, this.lines.length - this.maxLines);
    }
  }

  eraseFullLine() {
    this.lines[this.lines.length - 1] = "";
    this.col = 0;
  }

  eraseToEnd() {
    const idx = this.lines.length - 1;
    this.lines[idx] = this.lines[idx].slice(0, this.col);
  }

  eraseToCursor() {
    const idx = this.lines.length - 1;
    const line = this.lines[idx];
    this.lines[idx] = " ".repeat(this.col) + line.slice(this.col);
  }

  text() {
    return this.lines.join("\n");
  }
}
