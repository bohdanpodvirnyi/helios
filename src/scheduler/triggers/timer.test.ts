import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { evaluateTimer } from "./timer.js";
import type { TimerCondition } from "./types.js";

function timerCondition(wakeAt: number): TimerCondition {
  return { kind: "timer", wakeAt };
}

describe("evaluateTimer", () => {
  it("returns true when current time is past wakeAt", () => {
    const past = Date.now() - 60_000;
    expect(evaluateTimer(timerCondition(past))).toBe(true);
  });

  it("returns false when current time is before wakeAt", () => {
    const future = Date.now() + 60_000;
    expect(evaluateTimer(timerCondition(future))).toBe(false);
  });

  it("returns true when current time equals wakeAt", () => {
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    expect(evaluateTimer(timerCondition(now))).toBe(true);
    vi.restoreAllMocks();
  });

  it("handles wakeAt of 0 (always true)", () => {
    expect(evaluateTimer(timerCondition(0))).toBe(true);
  });

  it("handles wakeAt far in the future (false)", () => {
    const farFuture = Date.now() + 365 * 24 * 60 * 60 * 1000; // 1 year
    expect(evaluateTimer(timerCondition(farFuture))).toBe(false);
  });

  it("handles wakeAt = Date.now() (should be true since Date.now() >= wakeAt)", () => {
    const frozen = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(frozen);
    expect(evaluateTimer(timerCondition(frozen))).toBe(true);
    vi.restoreAllMocks();
  });

  it("handles very large timestamps", () => {
    const veryLarge = Number.MAX_SAFE_INTEGER;
    expect(evaluateTimer(timerCondition(veryLarge))).toBe(false);
  });

  it("returns true for wakeAt of 1 (epoch + 1ms)", () => {
    expect(evaluateTimer(timerCondition(1))).toBe(true);
  });

  it("uses Date.now() for comparison", () => {
    const frozen = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(frozen);
    expect(evaluateTimer(timerCondition(frozen - 1))).toBe(true);
    expect(evaluateTimer(timerCondition(frozen))).toBe(true);
    expect(evaluateTimer(timerCondition(frozen + 1))).toBe(false);
    vi.restoreAllMocks();
  });

  it("returns true when wakeAt is exactly 1ms before now", () => {
    const frozen = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(frozen);
    expect(evaluateTimer(timerCondition(frozen - 1))).toBe(true);
    vi.restoreAllMocks();
  });
});
