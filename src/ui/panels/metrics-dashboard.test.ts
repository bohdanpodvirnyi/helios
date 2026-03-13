import { describe, it, expect } from "vitest";
import { sparkline } from "./metrics-dashboard.js";
import { nameHash, METRIC_COLORS } from "../theme.js";

// Block characters used in sparkline, for reference:
// ▁ ▂ ▃ ▄ ▅ ▆ ▇ █  (indices 0-7)
const BLOCKS = ["\u2581", "\u2582", "\u2583", "\u2584", "\u2585", "\u2586", "\u2587", "\u2588"];

describe("sparkline", () => {
  it("returns empty string for empty array", () => {
    expect(sparkline([])).toBe("");
    expect(sparkline([], 10)).toBe("");
  });

  it("returns single block character for single value", () => {
    const result = sparkline([5]);
    expect(result).toHaveLength(1);
    expect(BLOCKS).toContain(result);
  });

  it("single value maps to first block (min === max, range forced to 1)", () => {
    // When min === max, range = 1, so (v - min) / range = 0 => index 0
    const result = sparkline([42]);
    expect(result).toBe(BLOCKS[0]);
  });

  it("all same values produce all same characters", () => {
    const result = sparkline([5, 5, 5, 5, 5], 5);
    expect(result).toHaveLength(5);
    // All chars should be identical
    const chars = [...result];
    expect(new Set(chars).size).toBe(1);
    // When all same, min === max, range = 1, (v - min)/range = 0 => index 0
    expect(chars[0]).toBe(BLOCKS[0]);
  });

  it("increasing values produce ascending block characters", () => {
    const values = [0, 1, 2, 3, 4, 5, 6, 7];
    const result = sparkline(values, 8);
    expect(result).toHaveLength(8);
    // First char should be lowest block, last should be highest
    expect(result[0]).toBe(BLOCKS[0]);
    expect(result[result.length - 1]).toBe(BLOCKS[7]);
    // Each character should be >= the previous one
    for (let i = 1; i < result.length; i++) {
      expect(BLOCKS.indexOf(result[i])).toBeGreaterThanOrEqual(
        BLOCKS.indexOf(result[i - 1]),
      );
    }
  });

  it("decreasing values produce descending block characters", () => {
    const values = [7, 6, 5, 4, 3, 2, 1, 0];
    const result = sparkline(values, 8);
    expect(result).toHaveLength(8);
    expect(result[0]).toBe(BLOCKS[7]);
    expect(result[result.length - 1]).toBe(BLOCKS[0]);
    // Each character should be <= the previous one
    for (let i = 1; i < result.length; i++) {
      expect(BLOCKS.indexOf(result[i])).toBeLessThanOrEqual(
        BLOCKS.indexOf(result[i - 1]),
      );
    }
  });

  it("values with wide range normalize correctly", () => {
    const values = [0, 1000000];
    const result = sparkline(values, 2);
    expect(result).toHaveLength(2);
    expect(result[0]).toBe(BLOCKS[0]); // min value
    expect(result[1]).toBe(BLOCKS[7]); // max value
  });

  it("width parameter controls output length by sampling", () => {
    // 20 values, width = 5 -> step = floor(20/5) = 4, samples at indices 0,4,8,12,16
    const values = Array.from({ length: 20 }, (_, i) => i);
    const result = sparkline(values, 5);
    expect(result.length).toBeLessThanOrEqual(5);
  });

  it("width larger than values length produces output of values.length", () => {
    // 3 values, width = 100 -> step = max(1, floor(3/100)) = 1
    // Iterates i=0,1,2, all sampled, length = 3 <= 100 so no truncation
    const values = [1, 2, 3];
    const result = sparkline(values, 100);
    expect(result).toHaveLength(3);
  });

  it("default width is 40", () => {
    // 80 values, default width 40 -> step = floor(80/40) = 2
    const values = Array.from({ length: 80 }, (_, i) => i);
    const result = sparkline(values);
    expect(result.length).toBeLessThanOrEqual(40);
  });

  it("handles negative values", () => {
    const values = [-10, -5, 0, 5, 10];
    const result = sparkline(values, 5);
    expect(result).toHaveLength(5);
    // -10 is min -> lowest block, 10 is max -> highest block
    expect(result[0]).toBe(BLOCKS[0]);
    expect(result[result.length - 1]).toBe(BLOCKS[7]);
  });

  it("handles all negative values", () => {
    const values = [-100, -50, -10];
    const result = sparkline(values, 3);
    expect(result).toHaveLength(3);
    expect(result[0]).toBe(BLOCKS[0]); // most negative = min
    expect(result[2]).toBe(BLOCKS[7]); // least negative = max
  });

  it("handles very large values", () => {
    const values = [1e15, 2e15, 3e15];
    const result = sparkline(values, 3);
    expect(result).toHaveLength(3);
    expect(result[0]).toBe(BLOCKS[0]);
    expect(result[2]).toBe(BLOCKS[7]);
  });

  it("handles mix of positive and zero values", () => {
    const values = [0, 0, 5, 10, 0];
    const result = sparkline(values, 5);
    expect(result).toHaveLength(5);
    // 0 is min, 10 is max
    expect(result[0]).toBe(BLOCKS[0]); // 0 -> min
    expect(result[3]).toBe(BLOCKS[7]); // 10 -> max
  });

  it("all zero values produce flat line", () => {
    const values = [0, 0, 0, 0];
    const result = sparkline(values, 4);
    expect(result).toHaveLength(4);
    const chars = [...result];
    // All the same character (min === max => range = 1, all map to index 0)
    expect(new Set(chars).size).toBe(1);
    expect(chars[0]).toBe(BLOCKS[0]);
  });

  it("two values produce correct min/max blocks", () => {
    const result = sparkline([0, 100], 2);
    expect(result).toBe(BLOCKS[0] + BLOCKS[7]);
  });

  it("correctly samples when values exceed width", () => {
    // 10 values, width 5 -> step = 2, samples at i=0,2,4,6,8
    const values = [0, 99, 10, 99, 20, 99, 30, 99, 40, 99];
    const result = sparkline(values, 5);
    // Sampled values: 0, 10, 20, 30, 40 (even indices)
    expect(result).toHaveLength(5);
    // Should be ascending since sampled even-index values are ascending
    for (let i = 1; i < result.length; i++) {
      expect(BLOCKS.indexOf(result[i])).toBeGreaterThanOrEqual(
        BLOCKS.indexOf(result[i - 1]),
      );
    }
  });

  it("values exactly at block boundaries", () => {
    // With 8 blocks and values 0..7, each maps to exactly one block index
    const values = [0, 1, 2, 3, 4, 5, 6, 7];
    const result = sparkline(values, 8);
    for (let i = 0; i < 8; i++) {
      expect(result[i]).toBe(BLOCKS[i]);
    }
  });
});

describe("nameHash", () => {
  it("returns a non-negative number", () => {
    expect(nameHash("loss")).toBeGreaterThanOrEqual(0);
    expect(nameHash("accuracy")).toBeGreaterThanOrEqual(0);
    expect(nameHash("")).toBeGreaterThanOrEqual(0);
  });

  it("returns 0 for empty string", () => {
    expect(nameHash("")).toBe(0);
  });

  it("returns consistent values for the same string", () => {
    const h1 = nameHash("train/loss");
    const h2 = nameHash("train/loss");
    expect(h1).toBe(h2);
  });

  it("returns different values for different strings", () => {
    const h1 = nameHash("loss");
    const h2 = nameHash("accuracy");
    expect(h1).not.toBe(h2);
  });

  it("produces valid index into METRIC_COLORS", () => {
    const testNames = ["loss", "accuracy", "lr", "epoch", "val_loss", "f1"];
    for (const name of testNames) {
      const idx = nameHash(name) % METRIC_COLORS.length;
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(METRIC_COLORS.length);
      expect(METRIC_COLORS[idx]).toBeDefined();
    }
  });

  it("distributes across multiple color indices", () => {
    const names = [
      "loss", "accuracy", "lr", "epoch", "val_loss", "f1",
      "precision", "recall", "train_loss", "val_accuracy",
      "grad_norm", "throughput", "latency", "memory_used",
    ];
    const indices = new Set(names.map((n) => nameHash(n) % METRIC_COLORS.length));
    // With 14 names and 10 colors, we should hit at least a few different indices
    expect(indices.size).toBeGreaterThanOrEqual(3);
  });

  it("handles special characters", () => {
    expect(nameHash("train/loss")).toBeGreaterThanOrEqual(0);
    expect(nameHash("metric.name")).toBeGreaterThanOrEqual(0);
    expect(nameHash("a-b-c")).toBeGreaterThanOrEqual(0);
  });

  it("handles unicode strings", () => {
    expect(nameHash("\u00e9poch")).toBeGreaterThanOrEqual(0);
    expect(nameHash("\u2603")).toBeGreaterThanOrEqual(0);
  });
});
