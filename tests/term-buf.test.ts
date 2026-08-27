import { describe, expect, it } from "vitest";
import { TermBuf } from "../src/dashboard/public/term.js";

describe("TermBuf CR progress", () => {
  it("overwrites the current line on \\r instead of erasing it", () => {
    const t = new TermBuf();
    t.write("aaaa\rbbbb");
    expect(t.text()).toBe("bbbb");
  });

  it("keeps the last CR update visible when the chunk ends with \\r", () => {
    const t = new TermBuf();
    t.write("Step 1/80 : compiling module-1\r");
    expect(t.text()).toContain("Step 1/80");
    t.write("Step 2/80 : compiling module-2\r");
    expect(t.text()).toBe("Step 2/80 : compiling module-2");
  });

  it("treats CRLF as a single newline", () => {
    const t = new TermBuf();
    t.write("one\r\ntwo\r\n");
    expect(t.text()).toBe("one\ntwo\n");
  });
});
