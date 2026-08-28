/** Tracks use without owning any observed process lifecycle. */
export class IdleShutdownTracker {
  private lastUsedAt: number;

  constructor(
    private readonly idleMs: number,
    private readonly now: () => number = Date.now,
  ) {
    this.lastUsedAt = now();
  }

  touch(): void {
    this.lastUsedAt = this.now();
  }

  shouldStop(hasActiveRuns: boolean): boolean {
    if (this.idleMs <= 0) return false;
    if (hasActiveRuns) {
      this.touch();
      return false;
    }
    return this.now() - this.lastUsedAt >= this.idleMs;
  }
}
