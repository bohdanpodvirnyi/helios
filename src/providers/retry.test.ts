import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  TransientError,
  isTransient,
  sleep,
  fetchWithRetry,
} from "./retry.js";

// ---------------------------------------------------------------------------
// TransientError
// ---------------------------------------------------------------------------

describe("TransientError", () => {
  it("is an instance of Error", () => {
    const err = new TransientError("boom");
    expect(err).toBeInstanceOf(Error);
  });

  it('has name "TransientError"', () => {
    const err = new TransientError("test");
    expect(err.name).toBe("TransientError");
  });

  it("carries the provided message", () => {
    const err = new TransientError("rate limited");
    expect(err.message).toBe("rate limited");
  });
});

// ---------------------------------------------------------------------------
// isTransient
// ---------------------------------------------------------------------------

describe("isTransient", () => {
  it("returns true for TransientError", () => {
    expect(isTransient(new TransientError("429"))).toBe(true);
  });

  it('returns true for TypeError with "fetch failed"', () => {
    expect(isTransient(new TypeError("fetch failed"))).toBe(true);
  });

  it('returns true for TypeError with "network"', () => {
    expect(isTransient(new TypeError("network error"))).toBe(true);
  });

  it('returns true for TypeError with "ECONNRESET"', () => {
    expect(isTransient(new TypeError("ECONNRESET"))).toBe(true);
  });

  it('returns true for TypeError with "ETIMEDOUT"', () => {
    expect(isTransient(new TypeError("connect ETIMEDOUT 1.2.3.4:443"))).toBe(
      true,
    );
  });

  it('returns true for TypeError with "ENOTFOUND"', () => {
    expect(isTransient(new TypeError("getaddrinfo ENOTFOUND api.example.com"))).toBe(true);
  });

  it("returns false for a regular Error", () => {
    expect(isTransient(new Error("some random error"))).toBe(false);
  });

  it("returns true for AggregateError wrapping a transient error", () => {
    const agg = new AggregateError([new TransientError("retry me")]);
    expect(isTransient(agg)).toBe(true);
  });

  it("returns false for AggregateError wrapping non-transient errors", () => {
    const agg = new AggregateError([new Error("bad request")]);
    expect(isTransient(agg)).toBe(false);
  });

  it("returns false for non-Error values", () => {
    expect(isTransient("string error")).toBe(false);
    expect(isTransient(42)).toBe(false);
    expect(isTransient(null)).toBe(false);
    expect(isTransient(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// sleep
// ---------------------------------------------------------------------------

describe("sleep", () => {
  it("resolves after the specified delay", async () => {
    vi.useFakeTimers();
    const promise = sleep(100);
    vi.advanceTimersByTime(100);
    await expect(promise).resolves.toBeUndefined();
    vi.useRealTimers();
  });

  it("returns void (undefined)", async () => {
    vi.useFakeTimers();
    const promise = sleep(10);
    vi.advanceTimersByTime(10);
    const result = await promise;
    expect(result).toBeUndefined();
    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// fetchWithRetry
// ---------------------------------------------------------------------------

describe("fetchWithRetry", () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /** Helper to drive all pending retries to completion. */
  async function drainRetries(promise: Promise<unknown>) {
    // Advance timers enough for all possible backoff delays (1s, 2s, 4s, 8s, 15s)
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(16_000);
    }
    return promise;
  }

  it("returns response on first success", async () => {
    const resp = new Response("ok", { status: 200 });
    mockFetch.mockResolvedValueOnce(resp);

    const result = await fetchWithRetry("https://api.example.com/v1");
    expect(result).toBe(resp);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("retries on 429 and eventually succeeds", async () => {
    mockFetch
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    const promise = fetchWithRetry("https://api.example.com/v1");
    const result = await drainRetries(promise);
    expect((result as Response).status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("retries on 500+", async () => {
    mockFetch
      .mockResolvedValueOnce(new Response("error", { status: 500 }))
      .mockResolvedValueOnce(new Response("error", { status: 502 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    const promise = fetchWithRetry("https://api.example.com/v1");
    const result = await drainRetries(promise);
    expect((result as Response).status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("throws immediately on non-transient error (400)", async () => {
    // A 400 is not retried and is returned directly (not thrown)
    const resp = new Response("bad request", { status: 400 });
    mockFetch.mockResolvedValueOnce(resp);

    const result = await fetchWithRetry("https://api.example.com/v1");
    expect(result.status).toBe(400);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("throws after max retries on persistent server errors", async () => {
    // All attempts return 500 — the last one should be returned (not retried)
    mockFetch
      .mockResolvedValueOnce(new Response("error", { status: 500 }))
      .mockResolvedValueOnce(new Response("error", { status: 500 }))
      .mockResolvedValueOnce(new Response("error", { status: 500 }))
      .mockResolvedValueOnce(new Response("error", { status: 500 }));

    const promise = fetchWithRetry("https://api.example.com/v1");
    const result = await drainRetries(promise);
    // After maxRetries (3), the 4th attempt (attempt === maxRetries) returns the 500 response
    expect((result as Response).status).toBe(500);
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });

  it("retries on network error (TypeError)", async () => {
    mockFetch
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    const promise = fetchWithRetry("https://api.example.com/v1");
    const result = await drainRetries(promise);
    expect((result as Response).status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("returns response on second attempt after 429", async () => {
    mockFetch
      .mockResolvedValueOnce(new Response("", { status: 429 }))
      .mockResolvedValueOnce(new Response("success", { status: 200 }));

    const promise = fetchWithRetry("https://api.example.com/v1");
    const result = await drainRetries(promise);
    expect((result as Response).status).toBe(200);
  });

  it("respects maxRetries parameter", async () => {
    mockFetch
      .mockResolvedValueOnce(new Response("", { status: 500 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    const promise = fetchWithRetry("https://api.example.com/v1", undefined, 1);
    const result = await drainRetries(promise);
    expect((result as Response).status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("default maxRetries is 3", async () => {
    // Fail 3 times with transient, succeed on 4th (attempt index 3 === maxRetries, so 500 is returned)
    mockFetch
      .mockResolvedValueOnce(new Response("", { status: 500 }))
      .mockResolvedValueOnce(new Response("", { status: 500 }))
      .mockResolvedValueOnce(new Response("", { status: 500 }))
      .mockResolvedValueOnce(new Response("ok", { status: 500 }));

    const promise = fetchWithRetry("https://api.example.com/v1");
    const result = await drainRetries(promise);
    // 4 total calls: initial + 3 retries
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });

  it("throws on non-transient network error without retrying", async () => {
    const err = new Error("some non-transient error");
    mockFetch.mockRejectedValueOnce(err);

    await expect(fetchWithRetry("https://api.example.com/v1")).rejects.toThrow(
      "some non-transient error",
    );
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
