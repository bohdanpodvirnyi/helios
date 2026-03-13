import { describe, it, expect } from "vitest";
import {
  estimateTokens,
  getContextBudget,
  getCheckpointThreshold,
} from "./token-estimator.js";

describe("estimateTokens", () => {
  it("estimates ~4 chars per token", () => {
    expect(estimateTokens("abcdefgh")).toBe(2); // 8 / 4
    expect(estimateTokens("abc")).toBe(1); // ceil(3/4) = 1
  });

  it("handles empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("rounds up", () => {
    expect(estimateTokens("a")).toBe(1); // ceil(1/4) = 1
    expect(estimateTokens("abcde")).toBe(2); // ceil(5/4) = 2
  });
});

describe("getContextBudget", () => {
  it("returns 80% of Claude model limit", () => {
    expect(getContextBudget("claude-opus-4-6")).toBe(160_000);
    expect(getContextBudget("claude-sonnet-4-6")).toBe(160_000);
  });

  it("returns 80% of OpenAI model limit", () => {
    expect(getContextBudget("gpt-5.4")).toBe(320_000);
    expect(getContextBudget("gpt-5.1")).toBe(320_000);
  });

  it("falls back to default for unknown models", () => {
    expect(getContextBudget("unknown-model-xyz")).toBe(160_000); // 80% of 200k
  });
});

describe("getCheckpointThreshold", () => {
  it("returns 85% of budget", () => {
    // Claude: 200k * 0.8 * 0.85 = 136,000
    expect(getCheckpointThreshold("claude-opus-4-6")).toBe(136_000);
  });

  it("scales with model size", () => {
    const claude = getCheckpointThreshold("claude-opus-4-6");
    const openai = getCheckpointThreshold("gpt-5.4");
    expect(openai).toBeGreaterThan(claude);
    // OpenAI: 400k * 0.8 * 0.85 = 272,000
    expect(openai).toBe(272_000);
  });
});
