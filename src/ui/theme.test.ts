import { describe, it, expect } from "vitest";
import { nameHash, C, G, METRIC_COLORS } from "./theme.js";

describe("nameHash", () => {
  it("returns consistent values for the same string", () => {
    const hash1 = nameHash("experiment-1");
    const hash2 = nameHash("experiment-1");
    expect(hash1).toBe(hash2);
  });

  it("returns consistent values across multiple calls", () => {
    const str = "loss/train";
    const results = Array.from({ length: 100 }, () => nameHash(str));
    expect(new Set(results).size).toBe(1);
  });

  it("returns different values for different strings", () => {
    const a = nameHash("alpha");
    const b = nameHash("beta");
    const c = nameHash("gamma");
    // All three should be distinct
    expect(a).not.toBe(b);
    expect(b).not.toBe(c);
    expect(a).not.toBe(c);
  });

  it("returns different values for similar strings", () => {
    const a = nameHash("test1");
    const b = nameHash("test2");
    expect(a).not.toBe(b);
  });

  it("returns different values for reversed strings", () => {
    const a = nameHash("abc");
    const b = nameHash("cba");
    expect(a).not.toBe(b);
  });

  it("handles empty string", () => {
    const result = nameHash("");
    expect(typeof result).toBe("number");
    expect(result).toBe(0); // h stays 0 with no iterations, Math.abs(0) = 0
    expect(Number.isFinite(result)).toBe(true);
  });

  it("handles single character strings", () => {
    const result = nameHash("a");
    expect(typeof result).toBe("number");
    expect(result).toBeGreaterThan(0);
  });

  it("handles long strings without crashing", () => {
    const longStr = "a".repeat(100_000);
    const result = nameHash(longStr);
    expect(typeof result).toBe("number");
    expect(Number.isFinite(result)).toBe(true);
  });

  it("returns non-negative values", () => {
    // Math.abs ensures non-negative
    const strings = ["hello", "world", "test", "foo", "bar", "baz", "!@#$%"];
    for (const s of strings) {
      expect(nameHash(s)).toBeGreaterThanOrEqual(0);
    }
  });

  it("handles strings with special characters", () => {
    const result = nameHash("émoji 🎉 special\n\ttabs");
    expect(typeof result).toBe("number");
    expect(Number.isFinite(result)).toBe(true);
    expect(result).toBeGreaterThanOrEqual(0);
  });

  it("handles strings with unicode", () => {
    const a = nameHash("日本語");
    const b = nameHash("中文");
    expect(typeof a).toBe("number");
    expect(typeof b).toBe("number");
    expect(a).not.toBe(b);
  });

  it("can be used to index into METRIC_COLORS", () => {
    const idx = nameHash("loss") % METRIC_COLORS.length;
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(idx).toBeLessThan(METRIC_COLORS.length);
    expect(METRIC_COLORS[idx]).toBeDefined();
  });
});

describe("METRIC_COLORS", () => {
  it("has exactly 10 colors", () => {
    expect(METRIC_COLORS).toHaveLength(10);
  });

  it("contains only non-empty strings", () => {
    for (const color of METRIC_COLORS) {
      expect(typeof color).toBe("string");
      expect(color.length).toBeGreaterThan(0);
    }
  });

  it("contains expected Ink color names", () => {
    // All entries should be valid Ink/chalk color names
    const validColors = new Set([
      "yellowBright", "cyanBright", "greenBright", "magentaBright",
      "redBright", "blueBright", "whiteBright", "yellow", "cyan", "green",
    ]);
    for (const color of METRIC_COLORS) {
      expect(validColors.has(color)).toBe(true);
    }
  });

  it("has unique entries", () => {
    const unique = new Set(METRIC_COLORS);
    expect(unique.size).toBe(METRIC_COLORS.length);
  });
});

describe("C (color constants)", () => {
  it("has all expected keys", () => {
    expect(C).toHaveProperty("primary");
    expect(C).toHaveProperty("bright");
    expect(C).toHaveProperty("text");
    expect(C).toHaveProperty("dim");
    expect(C).toHaveProperty("error");
    expect(C).toHaveProperty("success");
  });

  it("has non-empty string values", () => {
    for (const [key, value] of Object.entries(C)) {
      expect(typeof value).toBe("string");
      expect(value.length).toBeGreaterThan(0);
    }
  });

  it("has expected color values", () => {
    expect(C.primary).toBe("yellow");
    expect(C.bright).toBe("yellowBright");
    expect(C.text).toBe("white");
    expect(C.dim).toBe("gray");
    expect(C.error).toBe("red");
    expect(C.success).toBe("green");
  });
});

describe("G (glyph constants)", () => {
  it("has all expected keys", () => {
    expect(G).toHaveProperty("brand");
    expect(G).toHaveProperty("section");
    expect(G).toHaveProperty("bullet");
    expect(G).toHaveProperty("active");
    expect(G).toHaveProperty("dot");
    expect(G).toHaveProperty("dotDim");
    expect(G).toHaveProperty("rule");
    expect(G).toHaveProperty("dash");
  });

  it("has non-empty string values", () => {
    for (const [key, value] of Object.entries(G)) {
      expect(typeof value).toBe("string");
      expect(value.length).toBeGreaterThan(0);
    }
  });

  it("has expected glyph characters", () => {
    expect(G.brand).toBe("◈");
    expect(G.section).toBe("◈");
    expect(G.bullet).toBe("▹");
    expect(G.active).toBe("▸");
    expect(G.dot).toBe("◆");
    expect(G.dotDim).toBe("◇");
    expect(G.rule).toBe("━");
    expect(G.dash).toBe("╌");
  });

  it("each glyph is a single character", () => {
    for (const value of Object.values(G)) {
      expect([...value]).toHaveLength(1);
    }
  });
});
