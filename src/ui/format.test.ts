import { describe, it, expect } from "vitest";
import {
  formatMetricValue,
  formatDuration,
  truncate,
  formatError,
  formatBytes,
  shellQuote,
  toolError,
  toolResult,
} from "./format.js";

describe("formatMetricValue", () => {
  it("formats large numbers with 1 decimal", () => {
    expect(formatMetricValue(1234.5)).toBe("1234.5");
    expect(formatMetricValue(-5000)).toBe("-5000.0");
  });

  it("formats values >= 1 with 4 significant digits", () => {
    expect(formatMetricValue(3.14159)).toBe("3.142");
    expect(formatMetricValue(99.99)).toBe("99.99"); // 4 significant digits
  });

  it("formats small values with 3 significant digits", () => {
    expect(formatMetricValue(0.00567)).toBe("0.00567");
  });

  it("formats very small values in scientific notation", () => {
    expect(formatMetricValue(0.000001)).toBe("1.00e-6");
  });

  it("handles zero", () => {
    expect(formatMetricValue(0)).toBe("0.00e+0");
  });

  it("handles negative values", () => {
    expect(formatMetricValue(-0.5)).toBe("-0.500");
  });
});

describe("formatDuration", () => {
  it("formats seconds", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(5000)).toBe("5s");
    expect(formatDuration(59000)).toBe("59s");
  });

  it("formats minutes and seconds", () => {
    expect(formatDuration(60000)).toBe("1m 0s");
    expect(formatDuration(90000)).toBe("1m 30s");
    expect(formatDuration(3599000)).toBe("59m 59s");
  });

  it("formats hours and minutes", () => {
    expect(formatDuration(3600000)).toBe("1h 0m");
    expect(formatDuration(7500000)).toBe("2h 5m");
  });
});

describe("truncate", () => {
  it("returns short strings unchanged", () => {
    expect(truncate("hello", 10)).toBe("hello");
  });

  it("truncates with ellipsis", () => {
    expect(truncate("hello world", 6)).toBe("hello\u2026");
  });

  it("flattens whitespace when flatten=true", () => {
    expect(truncate("hello\n  world", 20, true)).toBe("hello world");
  });

  it("handles exact-length strings", () => {
    expect(truncate("abc", 3)).toBe("abc");
  });

  it("handles single char max", () => {
    expect(truncate("abc", 1)).toBe("\u2026");
  });
});

describe("formatError", () => {
  it("extracts message from Error", () => {
    expect(formatError(new Error("boom"))).toBe("boom");
  });

  it("converts non-Error values to string", () => {
    expect(formatError("oops")).toBe("oops");
    expect(formatError(42)).toBe("42");
    expect(formatError(null)).toBe("null");
  });
});

describe("formatBytes", () => {
  it("formats bytes", () => {
    expect(formatBytes(500)).toBe("500B");
  });

  it("formats kilobytes", () => {
    expect(formatBytes(1500)).toBe("2K");
  });

  it("formats megabytes", () => {
    expect(formatBytes(5_000_000)).toBe("5M");
  });

  it("formats gigabytes", () => {
    expect(formatBytes(1_500_000_000)).toBe("1.5G");
  });

  it("formats terabytes", () => {
    expect(formatBytes(2_000_000_000_000)).toBe("2.0T");
  });
});

describe("shellQuote", () => {
  it("wraps in single quotes", () => {
    expect(shellQuote("hello")).toBe("'hello'");
  });

  it("escapes single quotes", () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });

  it("handles empty string", () => {
    expect(shellQuote("")).toBe("''");
  });

  it("handles special shell characters", () => {
    const special = 'rm -rf "$(whoami)"';
    const quoted = shellQuote(special);
    expect(quoted).toBe(`'rm -rf "$(whoami)"'`);
  });

  it("handles paths with spaces", () => {
    expect(shellQuote("/path/to/my file.txt")).toBe("'/path/to/my file.txt'");
  });

  it("handles multiple single quotes", () => {
    expect(shellQuote("a'b'c")).toBe("'a'\\''b'\\''c'");
  });
});

describe("toolError", () => {
  it("returns JSON with error field", () => {
    const result = JSON.parse(toolError("something failed"));
    expect(result).toEqual({ error: "something failed" });
  });

  it("extracts Error message", () => {
    const result = JSON.parse(toolError(new Error("boom")));
    expect(result).toEqual({ error: "boom" });
  });
});

describe("toolResult", () => {
  it("serializes data as JSON", () => {
    expect(toolResult({ ok: true })).toBe('{"ok":true}');
  });
});
