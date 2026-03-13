import { describe, it, expect } from "vitest";
import { analyzeMetric } from "./analyzer.js";
import type { MetricPoint } from "./store.js";

function makePoints(values: number[]): MetricPoint[] {
  return values.map((value, i) => ({
    metricName: "test",
    value,
    timestamp: 1000 + i * 100,
  }));
}

describe("analyzeMetric", () => {
  it("returns insufficient_data for < 3 points", () => {
    expect(analyzeMetric([])).toMatchObject({ trend: "insufficient_data" });
    expect(analyzeMetric(makePoints([1]))).toMatchObject({ trend: "insufficient_data" });
    expect(analyzeMetric(makePoints([1, 2]))).toMatchObject({ trend: "insufficient_data" });
  });

  it("returns current value for insufficient data with 1 point", () => {
    const result = analyzeMetric(makePoints([42]));
    expect(result.currentValue).toBe(42);
  });

  it("detects decreasing trend", () => {
    const result = analyzeMetric(makePoints([10, 8, 6, 4, 2]));
    expect(result.trend).toBe("decreasing");
    expect(result.slope).toBeLessThan(0);
  });

  it("detects increasing trend", () => {
    const result = analyzeMetric(makePoints([1, 3, 5, 7, 9]));
    expect(result.trend).toBe("increasing");
    expect(result.slope).toBeGreaterThan(0);
  });

  it("detects plateau", () => {
    const result = analyzeMetric(makePoints([5, 5, 5, 5, 5]));
    expect(result.trend).toBe("plateau");
    expect(result.slope).toBe(0);
  });

  it("computes correct mean and stdDev", () => {
    const result = analyzeMetric(makePoints([2, 4, 4, 4, 6]));
    expect(result.meanValue).toBe(4);
    // Variance: ((2-4)^2 + 0 + 0 + 0 + (6-4)^2) / 5 = 8/5 = 1.6
    expect(result.stdDev).toBeCloseTo(Math.sqrt(1.6), 5);
  });

  it("detects NaN values", () => {
    const result = analyzeMetric(makePoints([1, NaN, 3, 4, 5]));
    expect(result.hasNaN).toBe(true);
  });

  it("detects Infinity values", () => {
    const result = analyzeMetric(makePoints([1, Infinity, 3, 4, 5]));
    expect(result.hasInf).toBe(true);
  });

  it("marks unstable when too many non-finite values", () => {
    const result = analyzeMetric(makePoints([NaN, Infinity, NaN, Infinity, 5]));
    // Only 1 valid value — insufficient for valid values check
    expect(result.trend).toBe("unstable");
  });

  it("uses windowSize to limit analysis", () => {
    const long = makePoints([100, 90, 80, 70, 60, 1, 2, 3, 4, 5]);
    const result = analyzeMetric(long, 5);
    // Last 5 values are [1,2,3,4,5] — increasing
    expect(result.trend).toBe("increasing");
  });

  it("reports currentValue as last valid value", () => {
    const result = analyzeMetric(makePoints([1, 2, 3, 4, 5]));
    expect(result.currentValue).toBe(5);
  });
});
