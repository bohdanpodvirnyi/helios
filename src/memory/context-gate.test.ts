import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb } from "../__tests__/db-helper.js";

// Mock getDb before importing MemoryStore / ContextGate
const mockDb = { current: createTestDb() };
vi.mock("../store/database.js", () => {
  const getDb = () => mockDb.current;
  class StmtCache {
    private cache = new Map();
    stmt(sql: string) {
      let s = this.cache.get(sql);
      if (!s) { s = getDb().prepare(sql); this.cache.set(sql, s); }
      return s;
    }
  }
  return { getDb, StmtCache, getHeliosDir: () => "/tmp/helios-test" };
});

const { MemoryStore } = await import("./memory-store.js");
const { ContextGate } = await import("./context-gate.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeGate(opts: { threshold?: number } = {}) {
  const memory = new MemoryStore("test-session");
  const gate = new ContextGate(memory, {
    thresholdOverride: opts.threshold,
  });
  return { memory, gate };
}

function mockExecutor(processes: Array<{ machineId: string; pid: number; command: string }>) {
  return {
    getBackgroundProcesses: vi.fn(() => processes),
  } as any;
}

function mockMetricStore(data: Record<string, { names: string[]; series: Record<string, { value: number }[]> }>) {
  return {
    getMetricNames: vi.fn((taskId: string) => data[taskId]?.names ?? []),
    getSeries: vi.fn((taskId: string, name: string, limit: number) => data[taskId]?.series[name] ?? []),
  } as any;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ContextGate", () => {
  beforeEach(() => {
    mockDb.current = createTestDb();
  });

  // -------------------------------------------------------------------------
  // checkThreshold
  // -------------------------------------------------------------------------
  describe("checkThreshold", () => {
    it("returns false when inputTokens is 0", () => {
      const { gate } = makeGate();
      expect(gate.checkThreshold("claude-opus-4-6", 0)).toBe(false);
    });

    it("returns false when below threshold", () => {
      const { gate } = makeGate({ threshold: 100_000 });
      expect(gate.checkThreshold("claude-opus-4-6", 50_000)).toBe(false);
    });

    it("returns true when at threshold", () => {
      const { gate } = makeGate({ threshold: 100_000 });
      expect(gate.checkThreshold("claude-opus-4-6", 100_000)).toBe(true);
    });

    it("returns true when above threshold", () => {
      const { gate } = makeGate({ threshold: 100_000 });
      expect(gate.checkThreshold("claude-opus-4-6", 150_000)).toBe(true);
    });

    it("uses model-specific thresholds for Claude models", () => {
      const { gate } = makeGate(); // no override → uses model defaults
      // Claude 200k * 0.8 * 0.85 = 136,000
      expect(gate.checkThreshold("claude-opus-4-6", 136_000)).toBe(true);
      expect(gate.checkThreshold("claude-opus-4-6", 135_999)).toBe(false);
    });

    it("uses model-specific thresholds for OpenAI models", () => {
      const { gate } = makeGate();
      // gpt-5.4 400k * 0.8 * 0.85 = 272,000
      expect(gate.checkThreshold("gpt-5.4", 272_000)).toBe(true);
      expect(gate.checkThreshold("gpt-5.4", 271_999)).toBe(false);
    });

    it("thresholdOverride overrides model defaults", () => {
      const { gate } = makeGate({ threshold: 50 });
      // Even with a Claude model that normally has ~136k threshold,
      // the override makes it 50
      expect(gate.checkThreshold("claude-opus-4-6", 50)).toBe(true);
      expect(gate.checkThreshold("claude-opus-4-6", 49)).toBe(false);
    });

    it("handles unknown model with fallback threshold", () => {
      const { gate } = makeGate();
      // Fallback: 200k * 0.8 * 0.85 = 136,000
      expect(gate.checkThreshold("unknown-future-model", 136_000)).toBe(true);
      expect(gate.checkThreshold("unknown-future-model", 135_999)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // performCheckpointWithGist
  // -------------------------------------------------------------------------
  describe("performCheckpointWithGist", () => {
    it("saves gist to /context/gist in memory", () => {
      const { gate, memory } = makeGate();
      gate.performCheckpointWithGist("This is my gist.");

      const node = memory.read("/context/gist");
      expect(node).not.toBeNull();
      expect(node!.content).toBe("This is my gist.");
    });

    it("saves active tasks when executor is set", () => {
      const { gate, memory } = makeGate();
      const executor = mockExecutor([
        { machineId: "gpu-1", pid: 1234, command: "python train.py --lr 0.01" },
      ]);
      gate.setExecutor(executor);

      gate.performCheckpointWithGist("checkpoint gist");

      const tasks = memory.read("/context/active-tasks");
      expect(tasks).not.toBeNull();
      expect(tasks!.content).toContain("gpu-1:1234");
      expect(tasks!.content).toContain("python train.py --lr 0.01");
    });

    it("returns a briefing string", () => {
      const { gate } = makeGate();
      const briefing = gate.performCheckpointWithGist("My gist content");
      expect(typeof briefing).toBe("string");
      expect(briefing.length).toBeGreaterThan(0);
    });

    it("briefing contains gist content", () => {
      const { gate } = makeGate();
      const briefing = gate.performCheckpointWithGist("Important progress note");
      expect(briefing).toContain("Important progress note");
    });

    it("briefing contains memory tree", () => {
      const { gate, memory } = makeGate();
      memory.write("/goal", "Train a good model", "Full details...");
      const briefing = gate.performCheckpointWithGist("gist");
      expect(briefing).toContain("goal:");
      expect(briefing).toContain("Train a good model");
    });

    it("briefing contains standard instructions", () => {
      const { gate } = makeGate();
      const briefing = gate.performCheckpointWithGist("gist");
      expect(briefing).toContain("CONTEXT CHECKPOINT");
      expect(briefing).toContain("memory_read(path)");
      expect(briefing).toContain("memory_write");
      expect(briefing).toContain("/sources/");
    });

    it("handles empty memory tree", () => {
      const { gate } = makeGate();
      // Only the gist node will be written by performCheckpointWithGist
      const briefing = gate.performCheckpointWithGist("gist");
      // Should not throw and should still have the checkpoint header
      expect(briefing).toContain("CONTEXT CHECKPOINT");
      expect(briefing).toContain("## Memory tree:");
    });

    it("handles no executor (skips active tasks)", () => {
      const { gate, memory } = makeGate();
      // No executor set — should not crash
      gate.performCheckpointWithGist("gist without executor");
      expect(memory.read("/context/active-tasks")).toBeNull();
    });

    it("active tasks include metric values when metricStore is set", () => {
      const { gate, memory } = makeGate();
      const executor = mockExecutor([
        { machineId: "gpu-1", pid: 100, command: "python train.py" },
      ]);
      const metricStore = mockMetricStore({
        "gpu-1:100": {
          names: ["loss", "accuracy"],
          series: {
            loss: [{ value: 0.42 }],
            accuracy: [{ value: 0.91 }],
          },
        },
      });
      gate.setExecutor(executor);
      gate.setMetricStore(metricStore);

      gate.performCheckpointWithGist("checkpoint gist");

      const tasks = memory.read("/context/active-tasks");
      expect(tasks).not.toBeNull();
      expect(tasks!.content).toContain("loss=0.42");
      expect(tasks!.content).toContain("accuracy=0.91");
    });

    it("active tasks gist includes task count", () => {
      const { gate, memory } = makeGate();
      const executor = mockExecutor([
        { machineId: "gpu-1", pid: 1, command: "cmd1" },
        { machineId: "gpu-2", pid: 2, command: "cmd2" },
      ]);
      gate.setExecutor(executor);

      gate.performCheckpointWithGist("gist");

      const tasks = memory.read("/context/active-tasks");
      expect(tasks!.gist).toContain("2 running task(s)");
    });
  });

  // -------------------------------------------------------------------------
  // buildBriefing
  // -------------------------------------------------------------------------
  describe("buildBriefing", () => {
    it("includes checkpoint header", () => {
      const { gate } = makeGate();
      const briefing = gate.buildBriefing("gist");
      expect(briefing).toContain("=== CONTEXT CHECKPOINT ===");
      expect(briefing).toContain("Helios");
    });

    it("includes gist section when provided", () => {
      const { gate } = makeGate();
      const briefing = gate.buildBriefing("My session gist here");
      expect(briefing).toContain("## Your gist");
      expect(briefing).toContain("My session gist here");
    });

    it("includes memory tree", () => {
      const { gate, memory } = makeGate();
      memory.write("/observations/lr-warmup", "LR warmup helps", "details");
      const briefing = gate.buildBriefing("gist");
      expect(briefing).toContain("## Memory tree:");
      expect(briefing).toContain("lr-warmup:");
    });

    it("includes standard instructions", () => {
      const { gate } = makeGate();
      const briefing = gate.buildBriefing("gist");
      expect(briefing).toContain("memory_read(path)");
      expect(briefing).toContain("memory_write");
      expect(briefing).toContain("Continue working toward your goal.");
    });

    it("handles null gist", () => {
      const { gate } = makeGate();
      const briefing = gate.buildBriefing(null);
      expect(briefing).not.toContain("## Your gist");
      expect(briefing).toContain("## Memory tree:");
    });

    it("handles empty tree", () => {
      const { gate } = makeGate();
      const briefing = gate.buildBriefing("gist");
      expect(briefing).toContain("(empty)");
    });
  });

  // -------------------------------------------------------------------------
  // Integration
  // -------------------------------------------------------------------------
  describe("integration", () => {
    it("onSessionStart updates memory session", () => {
      const { gate, memory } = makeGate();
      // Write in session "test-session"
      memory.write("/x", "first", "content");

      gate.onSessionStart("new-session");
      // After changing session, old data is not visible
      expect(memory.read("/x")).toBeNull();

      // Write in new session
      memory.write("/y", "second", "content");
      expect(memory.read("/y")).not.toBeNull();
    });

    it("setExecutor wires executor", () => {
      const { gate, memory } = makeGate();
      const executor = mockExecutor([
        { machineId: "m1", pid: 42, command: "echo hello" },
      ]);
      gate.setExecutor(executor);
      gate.performCheckpointWithGist("gist");

      // Active tasks should be saved
      const tasks = memory.read("/context/active-tasks");
      expect(tasks).not.toBeNull();
      expect(tasks!.content).toContain("m1:42");
    });

    it("setMetricStore wires metric store", () => {
      const { gate, memory } = makeGate();
      const executor = mockExecutor([
        { machineId: "m1", pid: 42, command: "train" },
      ]);
      const metricStore = mockMetricStore({
        "m1:42": {
          names: ["loss"],
          series: { loss: [{ value: 1.5 }] },
        },
      });
      gate.setExecutor(executor);
      gate.setMetricStore(metricStore);

      gate.performCheckpointWithGist("gist");

      const tasks = memory.read("/context/active-tasks");
      expect(tasks!.content).toContain("loss=1.5");
    });

    it("full flow: write memory -> checkpoint -> briefing includes content", () => {
      const { gate, memory } = makeGate();

      // Simulate agent writing observations
      memory.write("/goal", "Fine-tune GPT on domain data", "Detailed goal");
      memory.write("/observations/warmup", "LR warmup helps", "warmup=500 steps improved convergence");
      memory.write("/experiments/01-baseline", "baseline run", "loss=2.3, perplexity=10.0");

      // Perform checkpoint
      const briefing = gate.performCheckpointWithGist(
        "Made progress on baseline. LR warmup experiment queued.",
      );

      // Verify briefing completeness
      expect(briefing).toContain("=== CONTEXT CHECKPOINT ===");
      expect(briefing).toContain("Made progress on baseline");
      expect(briefing).toContain("goal:");
      expect(briefing).toContain("warmup:");
      expect(briefing).toContain("01-baseline:");
      expect(briefing).toContain("memory_read(path)");
    });

    it("skips active tasks section when executor has no processes", () => {
      const { gate, memory } = makeGate();
      const executor = mockExecutor([]); // no processes
      gate.setExecutor(executor);

      gate.performCheckpointWithGist("gist");

      // Should not create active-tasks node
      expect(memory.read("/context/active-tasks")).toBeNull();
    });

    it("truncates long commands in active task lines", () => {
      const { gate, memory } = makeGate();
      const longCommand = "python " + "a".repeat(200) + ".py";
      const executor = mockExecutor([
        { machineId: "m1", pid: 1, command: longCommand },
      ]);
      gate.setExecutor(executor);

      gate.performCheckpointWithGist("gist");

      const tasks = memory.read("/context/active-tasks");
      expect(tasks).not.toBeNull();
      // command is sliced to 80 chars
      expect(tasks!.content!.length).toBeLessThan(longCommand.length);
    });
  });
});
