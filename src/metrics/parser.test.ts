import { describe, it, expect } from "vitest";
import {
  patternsFromNames,
  patternsFromRegexes,
  parseWithPatterns,
} from "./parser.js";

describe("patternsFromNames", () => {
  it("creates regex for key=value format", () => {
    const mp = patternsFromNames(["loss"]);
    expect(mp.patterns.loss).toBeInstanceOf(RegExp);
  });

  it("matches key=value", () => {
    const mp = patternsFromNames(["loss"]);
    const result = parseWithPatterns("loss=0.5", mp);
    expect(result).toHaveLength(1);
    expect(result[0].metricName).toBe("loss");
    expect(result[0].value).toBe(0.5);
  });

  it("matches key: value", () => {
    const mp = patternsFromNames(["acc"]);
    const result = parseWithPatterns("acc: 0.95", mp);
    expect(result).toHaveLength(1);
    expect(result[0].value).toBe(0.95);
  });

  it("matches key = value with spaces", () => {
    const mp = patternsFromNames(["lr"]);
    const result = parseWithPatterns("lr = 0.001", mp);
    expect(result).toHaveLength(1);
    expect(result[0].value).toBe(0.001);
  });

  it("matches scientific notation", () => {
    const mp = patternsFromNames(["lr"]);
    const result = parseWithPatterns("lr=1e-4", mp);
    expect(result).toHaveLength(1);
    expect(result[0].value).toBe(0.0001);
  });

  it("matches negative values", () => {
    const mp = patternsFromNames(["loss"]);
    const result = parseWithPatterns("loss=-0.5", mp);
    expect(result).toHaveLength(1);
    expect(result[0].value).toBe(-0.5);
  });

  it("case insensitive", () => {
    const mp = patternsFromNames(["Loss"]);
    const result = parseWithPatterns("loss=1.5", mp);
    expect(result).toHaveLength(1);
  });

  it("handles multiple metrics on separate lines", () => {
    const mp = patternsFromNames(["loss", "acc"]);
    const output = "loss=0.5\nacc=0.9";
    const result = parseWithPatterns(output, mp);
    expect(result).toHaveLength(2);
    expect(result.find((p) => p.metricName === "loss")?.value).toBe(0.5);
    expect(result.find((p) => p.metricName === "acc")?.value).toBe(0.9);
  });

  it("handles multiple metrics on same line", () => {
    const mp = patternsFromNames(["loss", "acc"]);
    const result = parseWithPatterns("loss=0.5 acc=0.9", mp);
    expect(result).toHaveLength(2);
  });

  it("skips non-matching lines", () => {
    const mp = patternsFromNames(["loss"]);
    const result = parseWithPatterns("hello world\nloss=0.5\ngoodbye", mp);
    expect(result).toHaveLength(1);
  });

  it("escapes special regex chars in name", () => {
    const mp = patternsFromNames(["val.loss"]);
    // Should not match "valXloss" because the dot is escaped
    const result = parseWithPatterns("valXloss=1.0", mp);
    expect(result).toHaveLength(0);
  });

  it("ignores non-numeric values", () => {
    const mp = patternsFromNames(["loss"]);
    const result = parseWithPatterns("loss=NaN", mp);
    expect(result).toHaveLength(0);
  });
});

describe("patternsFromRegexes", () => {
  it("creates patterns from custom regex strings", () => {
    const mp = patternsFromRegexes({ loss: "Loss:\\s*([\\d.e+-]+)" });
    const result = parseWithPatterns("Loss: 0.234", mp);
    expect(result).toHaveLength(1);
    expect(result[0].value).toBe(0.234);
  });

  it("handles complex regex patterns", () => {
    const mp = patternsFromRegexes({
      epoch: "Epoch\\s+(\\d+)",
    });
    const result = parseWithPatterns("Epoch 5/100", mp);
    expect(result).toHaveLength(1);
    expect(result[0].value).toBe(5);
  });
});

describe("parseWithPatterns", () => {
  it("returns empty array for empty input", () => {
    const mp = patternsFromNames(["loss"]);
    expect(parseWithPatterns("", mp)).toHaveLength(0);
  });

  it("sets timestamp on points", () => {
    const mp = patternsFromNames(["loss"]);
    const result = parseWithPatterns("loss=1", mp);
    expect(result[0].timestamp).toBeGreaterThan(0);
  });

  it("handles Infinity as non-finite", () => {
    const mp = patternsFromRegexes({ val: "val=(.+)" });
    const result = parseWithPatterns("val=Infinity", mp);
    expect(result).toHaveLength(0);
  });
});
