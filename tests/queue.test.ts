import { describe, expect, it } from "vitest";
import { TelemetryQueue } from "../src/wrapper/queue.js";

describe("telemetry queue", () => {
  it("drops raw chunks on overflow and keeps structured events", () => {
    const q = new TelemetryQueue(8_000);
    let drops = 0;
    q.on("drop", (n) => {
      drops = n;
    });
    q.push({ t: "hb", id: "r1", ts: "t", dropped: 0 }, false);
    for (let i = 0; i < 200; i++) {
      q.push({ t: "raw", id: "r1", s: i, d: "x".repeat(200), n: 200 }, true);
    }
    expect(q.droppedChunks).toBeGreaterThan(0);
    expect(drops).toBeGreaterThan(0);
    expect(q.pending).toBeGreaterThan(0);
    const first = q.shift();
    expect(first?.line).toContain('"t":"hb"');
  });
});
