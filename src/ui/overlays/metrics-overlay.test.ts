import { describe, it, expect } from "vitest";

/**
 * Pure-logic tests for MetricsOverlay.
 *
 * We replicate the selection clamping, navigation bounds,
 * empty-state handling, rendering helpers, and chart downsampling.
 */

// ─── Selection Logic (from useInput + useEffect) ────────

function selectionUp(current: number, entriesLength: number): number {
  if (entriesLength === 0) return current;
  return Math.max(0, current - 1);
}

function selectionDown(current: number, entriesLength: number): number {
  if (entriesLength === 0) return current;
  return Math.min(entriesLength - 1, current + 1);
}

function clampSelection(selectedIndex: number, entriesLength: number): number {
  if (entriesLength === 0) return selectedIndex;
  if (selectedIndex >= entriesLength) return entriesLength - 1;
  return selectedIndex;
}

// ─── Body Height Calculation ────────────────────────────

function bodyHeight(height: number): number {
  return height - 1;
}

// ─── Chart Width Calculation ────────────────────────────

function chartWidth(width: number): number {
  return Math.max(20, width - 16);
}

// ─── Spark Width Calculation ────────────────────────────

function sparkWidth(width: number, nameLength: number): number {
  return Math.max(10, width - nameLength - 4);
}

// ─── Chart Downsampling Logic ───────────────────────────

function downsample(values: number[], width: number): number[] {
  if (values.length <= width) return values;
  const step = values.length / width;
  const sampled: number[] = [];
  for (let i = 0; i < width; i++) {
    sampled.push(values[Math.floor(i * step)]);
  }
  return sampled;
}

// ─── Trend Icons ────────────────────────────────────────

const TREND_ICONS: Record<string, string> = {
  decreasing: "↓",
  increasing: "↑",
  plateau: "→",
  unstable: "~",
  insufficient_data: "?",
};

function trendIcon(trend: string): string {
  return TREND_ICONS[trend] ?? "?";
}

// ─── Metric Stats Logic ─────────────────────────────────

function metricStats(values: number[]): { latest: number | null; min: number | null; max: number | null } {
  if (values.length === 0) return { latest: null, min: null, max: null };
  return {
    latest: values[values.length - 1],
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

// ─── Tests ──────────────────────────────────────────────

describe("MetricsOverlay — selection navigation", () => {
  it("up from 0 stays at 0", () => {
    expect(selectionUp(0, 5)).toBe(0);
  });

  it("up decrements by 1", () => {
    expect(selectionUp(3, 5)).toBe(2);
  });

  it("down increments by 1", () => {
    expect(selectionDown(0, 5)).toBe(1);
  });

  it("down from last entry stays at last", () => {
    expect(selectionDown(4, 5)).toBe(4);
  });

  it("up with empty entries returns current", () => {
    expect(selectionUp(0, 0)).toBe(0);
  });

  it("down with empty entries returns current", () => {
    expect(selectionDown(0, 0)).toBe(0);
  });

  it("up from 1 goes to 0", () => {
    expect(selectionUp(1, 3)).toBe(0);
  });

  it("down with single entry stays at 0", () => {
    expect(selectionDown(0, 1)).toBe(0);
  });
});

describe("MetricsOverlay — selection clamping", () => {
  it("clamps index when entries shrink", () => {
    expect(clampSelection(5, 3)).toBe(2);
  });

  it("does not clamp valid index", () => {
    expect(clampSelection(1, 3)).toBe(1);
  });

  it("clamps to 0 for single entry", () => {
    expect(clampSelection(5, 1)).toBe(0);
  });

  it("returns current for empty entries (no clamping)", () => {
    // The component only clamps when entries.length > 0
    expect(clampSelection(3, 0)).toBe(3);
  });

  it("exact boundary: index == length clamps to length - 1", () => {
    expect(clampSelection(3, 3)).toBe(2);
  });

  it("index 0 with entries stays at 0", () => {
    expect(clampSelection(0, 5)).toBe(0);
  });
});

describe("MetricsOverlay — empty metrics map", () => {
  it("entries array from empty map is empty", () => {
    const map = new Map<string, number[]>();
    const entries = Array.from(map.entries());
    expect(entries).toEqual([]);
    expect(entries.length).toBe(0);
  });

  it("selection navigation is no-op with empty entries", () => {
    expect(selectionUp(0, 0)).toBe(0);
    expect(selectionDown(0, 0)).toBe(0);
  });
});

describe("MetricsOverlay — body and chart dimensions", () => {
  it("body height = height - 1 (for header)", () => {
    expect(bodyHeight(40)).toBe(39);
    expect(bodyHeight(1)).toBe(0);
    expect(bodyHeight(0)).toBe(-1);
  });

  it("chart width has minimum of 20", () => {
    expect(chartWidth(30)).toBe(20);
    expect(chartWidth(36)).toBe(20);
    expect(chartWidth(37)).toBe(21);
  });

  it("chart width subtracts 16 for labels and padding", () => {
    expect(chartWidth(100)).toBe(84);
    expect(chartWidth(80)).toBe(64);
  });

  it("spark width has minimum of 10", () => {
    expect(sparkWidth(20, 15)).toBe(10);
    expect(sparkWidth(10, 5)).toBe(10);
  });

  it("spark width adjusts for metric name length", () => {
    expect(sparkWidth(80, 5)).toBe(71);
    expect(sparkWidth(80, 20)).toBe(56);
  });
});

describe("MetricsOverlay — chart downsampling", () => {
  it("returns values unchanged when fewer than width", () => {
    const values = [1, 2, 3, 4, 5];
    expect(downsample(values, 10)).toEqual(values);
  });

  it("returns values unchanged when exactly width", () => {
    const values = [1, 2, 3, 4, 5];
    expect(downsample(values, 5)).toEqual(values);
  });

  it("downsamples to target width", () => {
    const values = Array.from({ length: 100 }, (_, i) => i);
    const sampled = downsample(values, 10);
    expect(sampled.length).toBe(10);
    // First sample should be index 0
    expect(sampled[0]).toBe(0);
    // Second sample: floor(1 * 10) = 10
    expect(sampled[1]).toBe(10);
  });

  it("preserves first value", () => {
    const values = [42, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    const sampled = downsample(values, 3);
    expect(sampled[0]).toBe(42);
  });

  it("handles single-value arrays", () => {
    expect(downsample([5], 1)).toEqual([5]);
  });

  it("handles empty arrays", () => {
    expect(downsample([], 10)).toEqual([]);
  });
});

describe("MetricsOverlay — trend icons", () => {
  it("maps known trends to icons", () => {
    expect(trendIcon("decreasing")).toBe("↓");
    expect(trendIcon("increasing")).toBe("↑");
    expect(trendIcon("plateau")).toBe("→");
    expect(trendIcon("unstable")).toBe("~");
    expect(trendIcon("insufficient_data")).toBe("?");
  });

  it("returns ? for unknown trends", () => {
    expect(trendIcon("unknown_trend")).toBe("?");
    expect(trendIcon("")).toBe("?");
  });
});

describe("MetricsOverlay — metric stats computation", () => {
  it("computes latest, min, max for normal values", () => {
    const stats = metricStats([3, 1, 4, 1, 5, 9, 2, 6]);
    expect(stats.latest).toBe(6);
    expect(stats.min).toBe(1);
    expect(stats.max).toBe(9);
  });

  it("returns null for empty array", () => {
    const stats = metricStats([]);
    expect(stats.latest).toBeNull();
    expect(stats.min).toBeNull();
    expect(stats.max).toBeNull();
  });

  it("handles single value", () => {
    const stats = metricStats([42]);
    expect(stats.latest).toBe(42);
    expect(stats.min).toBe(42);
    expect(stats.max).toBe(42);
  });

  it("handles negative values", () => {
    const stats = metricStats([-5, -2, -8, -1]);
    expect(stats.latest).toBe(-1);
    expect(stats.min).toBe(-8);
    expect(stats.max).toBe(-1);
  });

  it("handles identical values", () => {
    const stats = metricStats([7, 7, 7]);
    expect(stats.min).toBe(7);
    expect(stats.max).toBe(7);
  });
});

describe("MetricsOverlay — entries ordering from Map", () => {
  it("preserves insertion order", () => {
    const map = new Map<string, number[]>();
    map.set("loss", [0.5, 0.4]);
    map.set("accuracy", [0.8, 0.9]);
    map.set("lr", [0.001]);
    const entries = Array.from(map.entries());
    expect(entries.map(([name]) => name)).toEqual(["loss", "accuracy", "lr"]);
  });

  it("selected entry determined by index into entries array", () => {
    const map = new Map<string, number[]>();
    map.set("loss", [0.5]);
    map.set("accuracy", [0.9]);
    const entries = Array.from(map.entries());
    const selectedIndex = 1;
    const [name, values] = entries[selectedIndex];
    expect(name).toBe("accuracy");
    expect(values).toEqual([0.9]);
  });
});
