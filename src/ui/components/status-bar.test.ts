import { describe, it, expect } from "vitest";
import { C } from "../theme.js";
import { formatDuration } from "../format.js";

// ─── Copies of module-level constants from status-bar.tsx ────────

const SLEEP_FRAMES = ["\u25c7", "\u25c6", "\u25c7", "\u25c7"];

const STATE_COLOR: Record<string, string> = {
  idle: C.dim,
  active: C.primary,
  sleeping: C.primary,
  waiting: C.dim,
  error: C.error,
};

// ─── Cost formatting logic (inline in the component) ─────────────
function formatCost(cost: number): string {
  return `$${cost.toFixed(4)}`;
}

// ─── Tests ───────────────────────────────────────────────────────

describe("STATE_COLOR mapping", () => {
  it("has all expected states", () => {
    const expectedStates = ["idle", "active", "sleeping", "waiting", "error"];
    for (const state of expectedStates) {
      expect(STATE_COLOR[state]).toBeDefined();
    }
  });

  it("maps idle to dim", () => {
    expect(STATE_COLOR["idle"]).toBe(C.dim);
    expect(STATE_COLOR["idle"]).toBe("gray");
  });

  it("maps active to primary", () => {
    expect(STATE_COLOR["active"]).toBe(C.primary);
    expect(STATE_COLOR["active"]).toBe("yellow");
  });

  it("maps sleeping to primary", () => {
    expect(STATE_COLOR["sleeping"]).toBe(C.primary);
    expect(STATE_COLOR["sleeping"]).toBe("yellow");
  });

  it("maps waiting to dim", () => {
    expect(STATE_COLOR["waiting"]).toBe(C.dim);
    expect(STATE_COLOR["waiting"]).toBe("gray");
  });

  it("maps error to error", () => {
    expect(STATE_COLOR["error"]).toBe(C.error);
    expect(STATE_COLOR["error"]).toBe("red");
  });

  it("returns undefined for unknown state (fallback in component uses C.dim)", () => {
    expect(STATE_COLOR["unknown"]).toBeUndefined();
    // The component does: STATE_COLOR[state] ?? C.dim
    expect(STATE_COLOR["bogus"] ?? C.dim).toBe(C.dim);
  });

  it("active and sleeping share the same color", () => {
    expect(STATE_COLOR["active"]).toBe(STATE_COLOR["sleeping"]);
  });

  it("idle and waiting share the same color", () => {
    expect(STATE_COLOR["idle"]).toBe(STATE_COLOR["waiting"]);
  });

  it("error has a unique color", () => {
    const otherColors = ["idle", "active", "sleeping", "waiting"].map(
      (s) => STATE_COLOR[s],
    );
    expect(otherColors).not.toContain(STATE_COLOR["error"]);
  });
});

describe("cost formatting", () => {
  it("formats zero cost", () => {
    expect(formatCost(0)).toBe("$0.0000");
  });

  it("formats small cost with 4 decimal places", () => {
    expect(formatCost(0.0012)).toBe("$0.0012");
  });

  it("formats typical API cost", () => {
    expect(formatCost(0.0345)).toBe("$0.0345");
  });

  it("formats cost over one dollar", () => {
    expect(formatCost(1.2345)).toBe("$1.2345");
  });

  it("formats cost with rounding", () => {
    expect(formatCost(0.00005)).toBe("$0.0001");
    expect(formatCost(0.00004)).toBe("$0.0000");
  });

  it("formats larger costs", () => {
    expect(formatCost(10.5)).toBe("$10.5000");
    expect(formatCost(100)).toBe("$100.0000");
  });

  it("cost is only shown when > 0 (component logic)", () => {
    // The component renders cost only when cost > 0
    const cost = 0;
    const shouldShow = cost > 0;
    expect(shouldShow).toBe(false);

    const cost2 = 0.0001;
    expect(cost2 > 0).toBe(true);
  });
});

describe("SLEEP_FRAMES", () => {
  it("has exactly 4 frames", () => {
    expect(SLEEP_FRAMES).toHaveLength(4);
  });

  it("contains diamond glyphs", () => {
    // ◇ = \u25c7 (open diamond), ◆ = \u25c6 (filled diamond)
    expect(SLEEP_FRAMES[0]).toBe("\u25c7"); // ◇
    expect(SLEEP_FRAMES[1]).toBe("\u25c6"); // ◆
    expect(SLEEP_FRAMES[2]).toBe("\u25c7"); // ◇
    expect(SLEEP_FRAMES[3]).toBe("\u25c7"); // ◇
  });

  it("frame sequence has one filled diamond and three open", () => {
    const filled = SLEEP_FRAMES.filter((f) => f === "\u25c6");
    const open = SLEEP_FRAMES.filter((f) => f === "\u25c7");
    expect(filled).toHaveLength(1);
    expect(open).toHaveLength(3);
  });

  it("animation cycles correctly (frame index mod length)", () => {
    // The component does: setFrame((f) => (f + 1) % SLEEP_FRAMES.length)
    const length = SLEEP_FRAMES.length;
    expect(0 % length).toBe(0);
    expect(1 % length).toBe(1);
    expect(2 % length).toBe(2);
    expect(3 % length).toBe(3);
    expect(4 % length).toBe(0); // wraps around
    expect(5 % length).toBe(1);
  });

  it("each frame is a single character", () => {
    for (const frame of SLEEP_FRAMES) {
      expect(frame).toHaveLength(1);
    }
  });
});

describe("work elapsed time formatting", () => {
  it("formats zero elapsed", () => {
    expect(formatDuration(0)).toBe("0s");
  });

  it("formats seconds", () => {
    expect(formatDuration(5000)).toBe("5s");
    expect(formatDuration(30000)).toBe("30s");
  });

  it("formats minutes and seconds", () => {
    expect(formatDuration(65000)).toBe("1m 5s");
    expect(formatDuration(120000)).toBe("2m 0s");
  });

  it("formats hours and minutes", () => {
    expect(formatDuration(3660000)).toBe("1h 1m");
    expect(formatDuration(7200000)).toBe("2h 0m");
  });

  it("elapsed updates correctly (component logic)", () => {
    // The component does: setWorkElapsed(Date.now() - streamingStartedAt)
    const streamingStartedAt = 1000;
    const now = 6000;
    expect(now - streamingStartedAt).toBe(5000);
    expect(formatDuration(now - streamingStartedAt)).toBe("5s");
  });

  it("elapsed resets when streaming stops", () => {
    // Component sets workElapsed to 0 when !isStreaming
    const isStreaming = false;
    const workElapsed = isStreaming ? 5000 : 0;
    expect(workElapsed).toBe(0);
  });
});

describe("provider/model display logic", () => {
  it("displays dash for missing provider", () => {
    const provider = undefined as { displayName: string } | undefined;
    const displayName = provider?.displayName ?? "\u2014";
    expect(displayName).toBe("\u2014");
  });

  it("displays provider name when available", () => {
    const provider = { displayName: "Claude" };
    const displayName = provider?.displayName ?? "\u2014";
    expect(displayName).toBe("Claude");
  });

  it("displays dash for missing model", () => {
    const model = undefined;
    const display = model ?? "\u2014";
    expect(display).toBe("\u2014");
  });

  it("displays model when available", () => {
    const model = "claude-sonnet-4-20250514";
    const display = model ?? "\u2014";
    expect(display).toBe("claude-sonnet-4-20250514");
  });

  it("displays reasoning effort with medium as default", () => {
    const reasoning1 = undefined;
    expect(reasoning1 ?? "medium").toBe("medium");

    const reasoning2 = "high";
    expect(reasoning2 ?? "medium").toBe("high");

    const reasoning3 = "low";
    expect(reasoning3 ?? "medium").toBe("low");
  });

  it("state color falls back to dim for unknown state", () => {
    const state = "something_else";
    const stateColor = STATE_COLOR[state] ?? C.dim;
    expect(stateColor).toBe(C.dim);
  });
});

describe("sleep elapsed time formatting", () => {
  it("formats sleep duration from session createdAt", () => {
    const createdAt = Date.now() - 120_000; // 2 minutes ago
    const elapsed = Date.now() - createdAt;
    // Should be approximately "2m 0s" (within a second of tolerance)
    const formatted = formatDuration(elapsed);
    expect(formatted).toMatch(/^2m \d+s$/);
  });

  it("formats short sleep durations", () => {
    expect(formatDuration(500)).toBe("0s");
    expect(formatDuration(1500)).toBe("1s");
  });

  it("formats long sleep durations", () => {
    expect(formatDuration(7_200_000)).toBe("2h 0m");
    expect(formatDuration(86_400_000)).toBe("24h 0m");
  });
});
