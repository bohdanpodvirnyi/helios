import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb } from "../__tests__/db-helper.js";

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
const { ExperimentTracker } = await import("./experiment-tracker.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTracker() {
  const memory = new MemoryStore("test-session");
  const tracker = new ExperimentTracker(memory);
  return { memory, tracker };
}

function toolCallEvent(
  id: string,
  name: string,
  args: Record<string, unknown>,
) {
  return { type: "tool_call" as const, id, name, args };
}

function toolResultEvent(
  callId: string,
  result: string,
  isError = false,
) {
  return { type: "tool_result" as const, callId, result, isError };
}

/**
 * Fire a matching tool_call + tool_result pair through the tracker.
 * Returns the machine:pid key.
 */
function fireExperiment(
  tracker: ReturnType<typeof makeTracker>["tracker"],
  opts: {
    callId?: string;
    command?: string;
    machineId?: string;
    pid?: number;
    metricNames?: string[];
  } = {},
) {
  const callId = opts.callId ?? "call-1";
  const command = opts.command ?? "python train.py --lr 0.01";
  const machineId = opts.machineId ?? "gpu-1";
  const pid = opts.pid ?? 1234;

  const args: Record<string, unknown> = {
    command,
    machine_id: machineId,
  };
  if (opts.metricNames) args.metric_names = opts.metricNames;

  tracker.onEvent(toolCallEvent(callId, "remote_exec_background", args));
  tracker.onEvent(
    toolResultEvent(
      callId,
      JSON.stringify({ machine_id: machineId, pid }),
    ),
  );

  return `${machineId}:${pid}`;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ExperimentTracker", () => {
  beforeEach(() => {
    mockDb.current = createTestDb();
  });

  // -------------------------------------------------------------------------
  // onEvent
  // -------------------------------------------------------------------------
  describe("onEvent", () => {
    it("ignores non-tool_call events", () => {
      const { tracker, memory } = makeTracker();
      tracker.onEvent({ type: "text", text: "hello" } as any);
      expect(memory.ls("/experiments/")).toHaveLength(0);
    });

    it("ignores tool_call for non-remote_exec_background", () => {
      const { tracker, memory } = makeTracker();
      tracker.onEvent(toolCallEvent("c1", "remote_exec", { command: "ls" }));
      tracker.onEvent(toolResultEvent("c1", JSON.stringify({ pid: 100 })));
      expect(memory.ls("/experiments/")).toHaveLength(0);
    });

    it("stores pending call on tool_call event", () => {
      const { tracker, memory } = makeTracker();
      // Send tool_call without a result — should not create an experiment yet
      tracker.onEvent(
        toolCallEvent("c1", "remote_exec_background", {
          command: "python train.py",
          machine_id: "gpu-1",
        }),
      );
      expect(memory.ls("/experiments/")).toHaveLength(0);
    });

    it("creates experiment entry on successful tool_result", () => {
      const { tracker, memory } = makeTracker();
      fireExperiment(tracker);
      const experiments = memory.ls("/experiments/");
      expect(experiments.length).toBeGreaterThanOrEqual(1);
    });

    it("ignores tool_result with isError", () => {
      const { tracker, memory } = makeTracker();
      tracker.onEvent(
        toolCallEvent("c1", "remote_exec_background", {
          command: "python fail.py",
          machine_id: "gpu-1",
        }),
      );
      tracker.onEvent(toolResultEvent("c1", "Connection refused", true));
      expect(memory.ls("/experiments/")).toHaveLength(0);
    });

    it("ignores tool_result for non-pending call", () => {
      const { tracker, memory } = makeTracker();
      // Result without a preceding call
      tracker.onEvent(
        toolResultEvent("unknown-call", JSON.stringify({ pid: 999 })),
      );
      expect(memory.ls("/experiments/")).toHaveLength(0);
    });

    it("auto-numbers experiments (01-, 02-, etc.)", () => {
      const { tracker, memory } = makeTracker();
      fireExperiment(tracker, { callId: "c1", command: "python a.py", pid: 1 });
      fireExperiment(tracker, { callId: "c2", command: "python b.py", pid: 2 });

      const experiments = memory.ls("/experiments/");
      const paths = experiments.map((e) => e.path);
      expect(paths.some((p) => p.includes("01-"))).toBe(true);
      expect(paths.some((p) => p.includes("02-"))).toBe(true);
    });

    it("slugifies command for experiment name", () => {
      const { tracker, memory } = makeTracker();
      fireExperiment(tracker, { command: "python train.py --lr=0.01" });

      const experiments = memory.ls("/experiments/");
      expect(experiments.length).toBeGreaterThanOrEqual(1);
      // Should contain "python-trainpy" or similar (slugified first 3 words)
      const path = experiments.find((e) => !e.isDir)?.path ?? "";
      expect(path).toMatch(/01-python/);
    });

    it("writes correct gist (machine:pid -- command)", () => {
      const { tracker, memory } = makeTracker();
      fireExperiment(tracker, {
        machineId: "gpu-2",
        pid: 5678,
        command: "python train.py",
      });

      const experiments = memory.ls("/experiments/");
      const exp = experiments.find((e) => !e.isDir);
      expect(exp).toBeDefined();
      expect(exp!.gist).toContain("gpu-2:5678");
      expect(exp!.gist).toContain("python train.py");
    });

    it("writes correct content (command, machine, pid, status, started)", () => {
      const { tracker, memory } = makeTracker();
      fireExperiment(tracker, {
        machineId: "gpu-1",
        pid: 100,
        command: "python train.py --epochs 10",
      });

      const experiments = memory.ls("/experiments/");
      const exp = experiments.find((e) => !e.isDir);
      const node = memory.read(exp!.path);
      expect(node).not.toBeNull();
      expect(node!.content).toContain("command: python train.py --epochs 10");
      expect(node!.content).toContain("machine: gpu-1");
      expect(node!.content).toContain("pid: 100");
      expect(node!.content).toContain("status: running");
      expect(node!.content).toContain("started:");
    });

    it("includes metric_names in content when present", () => {
      const { tracker, memory } = makeTracker();
      fireExperiment(tracker, {
        metricNames: ["loss", "accuracy"],
      });

      const experiments = memory.ls("/experiments/");
      const exp = experiments.find((e) => !e.isDir);
      const node = memory.read(exp!.path);
      expect(node!.content).toContain("metrics: loss, accuracy");
    });

    it("creates /experiments/ directory", () => {
      const { tracker, memory } = makeTracker();
      fireExperiment(tracker);
      expect(memory.exists("/experiments/")).toBe(true);
    });

    it("ignores tool_result with no pid in result", () => {
      const { tracker, memory } = makeTracker();
      tracker.onEvent(
        toolCallEvent("c1", "remote_exec_background", {
          command: "python train.py",
          machine_id: "gpu-1",
        }),
      );
      tracker.onEvent(
        toolResultEvent("c1", JSON.stringify({ machine_id: "gpu-1" })),
      );
      // No pid — should not create experiment
      expect(memory.ls("/experiments/")).toHaveLength(0);
    });

    it("handles JSON parse failure gracefully", () => {
      const { tracker, memory } = makeTracker();
      tracker.onEvent(
        toolCallEvent("c1", "remote_exec_background", {
          command: "python train.py",
          machine_id: "gpu-1",
        }),
      );
      tracker.onEvent(toolResultEvent("c1", "not valid json at all"));
      // Should not throw and should not create experiment
      expect(memory.ls("/experiments/")).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // updateExperiment
  // -------------------------------------------------------------------------
  describe("updateExperiment", () => {
    it("updates experiment with exit code and metrics", () => {
      const { tracker, memory } = makeTracker();
      fireExperiment(tracker, { machineId: "gpu-1", pid: 100 });

      tracker.updateExperiment("gpu-1", 100, 0, { loss: 0.42, accuracy: 0.91 });

      const experiments = memory.ls("/experiments/");
      const exp = experiments.find((e) => !e.isDir);
      const node = memory.read(exp!.path);
      expect(node!.content).toContain("exit_code: 0");
      expect(node!.content).toContain("final_metrics:");
      expect(node!.content).toContain("0.42");
    });

    it("sets status to 'completed' for exit code 0", () => {
      const { tracker, memory } = makeTracker();
      fireExperiment(tracker, { machineId: "gpu-1", pid: 100 });

      tracker.updateExperiment("gpu-1", 100, 0);

      const experiments = memory.ls("/experiments/");
      const exp = experiments.find((e) => !e.isDir);
      const node = memory.read(exp!.path);
      expect(node!.content).toContain("status: completed");
    });

    it("sets status to 'failed' for non-zero exit code", () => {
      const { tracker, memory } = makeTracker();
      fireExperiment(tracker, { machineId: "gpu-1", pid: 100 });

      tracker.updateExperiment("gpu-1", 100, 1);

      const experiments = memory.ls("/experiments/");
      const exp = experiments.find((e) => !e.isDir);
      const node = memory.read(exp!.path);
      expect(node!.content).toContain("status: failed (exit 1)");
    });

    it("includes final_metrics in content", () => {
      const { tracker, memory } = makeTracker();
      fireExperiment(tracker, { machineId: "gpu-1", pid: 100 });

      tracker.updateExperiment("gpu-1", 100, 0, { loss: 1.5, perplexity: 4.2 });

      const experiments = memory.ls("/experiments/");
      const exp = experiments.find((e) => !e.isDir);
      const node = memory.read(exp!.path);
      expect(node!.content).toContain("final_metrics:");
      expect(node!.content).toContain("loss");
      expect(node!.content).toContain("1.5");
      expect(node!.content).toContain("perplexity");
    });

    it("removes experiment from pending after update", () => {
      const { tracker, memory } = makeTracker();
      fireExperiment(tracker, { machineId: "gpu-1", pid: 100 });

      tracker.updateExperiment("gpu-1", 100, 0);
      // Second update should be a no-op — experiment already removed
      tracker.updateExperiment("gpu-1", 100, 1);

      // The content should still show the first update (completed, not failed)
      const experiments = memory.ls("/experiments/");
      const exp = experiments.find((e) => !e.isDir);
      const node = memory.read(exp!.path);
      expect(node!.content).toContain("status: completed");
    });

    it("ignores unknown machine:pid combos", () => {
      const { tracker, memory } = makeTracker();
      // Update something that was never tracked
      tracker.updateExperiment("unknown-machine", 9999, 0, { loss: 0.1 });
      // Should not throw and memory should be empty
      expect(memory.ls("/experiments/")).toHaveLength(0);
    });

    it("handles metrics as 'none' when not provided", () => {
      const { tracker, memory } = makeTracker();
      fireExperiment(tracker, { machineId: "gpu-1", pid: 100 });

      tracker.updateExperiment("gpu-1", 100, 0);

      const experiments = memory.ls("/experiments/");
      const exp = experiments.find((e) => !e.isDir);
      const node = memory.read(exp!.path);
      // gist should contain "none"
      expect(exp!.gist).toContain("none");
    });

    it("updates gist with final info", () => {
      const { tracker, memory } = makeTracker();
      fireExperiment(tracker, { machineId: "gpu-1", pid: 100, command: "python train.py" });

      tracker.updateExperiment("gpu-1", 100, 0, { loss: 0.5 });

      const experiments = memory.ls("/experiments/");
      const exp = experiments.find((e) => !e.isDir);
      expect(exp!.gist).toContain("gpu-1:100");
      expect(exp!.gist).toContain("loss=0.5");
      expect(exp!.gist).toContain("completed");
    });
  });

  // -------------------------------------------------------------------------
  // slugify behavior (tested via onEvent)
  // -------------------------------------------------------------------------
  describe("slugify (via onEvent)", () => {
    it("extracts first 3 words from command", () => {
      const { tracker, memory } = makeTracker();
      fireExperiment(tracker, { command: "python train.py --lr 0.01 --epochs 50" });

      const experiments = memory.ls("/experiments/");
      const exp = experiments.find((e) => !e.isDir);
      // slugify takes first 3 words: "python", "trainpy", "--lr"
      // after removing special chars: "python", "trainpy", "lr"
      expect(exp!.path).toMatch(/01-python/);
    });

    it("lowercases result", () => {
      const { tracker, memory } = makeTracker();
      fireExperiment(tracker, { command: "Python TRAIN.PY" });

      const experiments = memory.ls("/experiments/");
      const exp = experiments.find((e) => !e.isDir);
      const name = exp!.path.split("/").pop()!;
      expect(name).toBe(name.toLowerCase());
    });

    it("removes special characters", () => {
      const { tracker, memory } = makeTracker();
      fireExperiment(tracker, { command: "python ../../scripts/train.py" });

      const experiments = memory.ls("/experiments/");
      const exp = experiments.find((e) => !e.isDir);
      // dots and slashes should be stripped
      expect(exp!.path).not.toContain("..");
    });

    it("truncates to 30 chars", () => {
      const { tracker, memory } = makeTracker();
      // Very long words
      fireExperiment(tracker, { command: "aaaaaaaaaaaaa bbbbbbbbbbbbb ccccccccccccc ddddddddddd" });

      const experiments = memory.ls("/experiments/");
      const exp = experiments.find((e) => !e.isDir);
      // Path is "/experiments/01-slug" where slug <= 30 chars
      const name = exp!.path.replace("/experiments/", "");
      // "01-" prefix + slug; the slug part itself is <= 30 chars
      const slugPart = name.replace(/^\d+-/, "");
      expect(slugPart.length).toBeLessThanOrEqual(30);
    });

    it("returns 'run' for empty/invalid commands", () => {
      const { tracker, memory } = makeTracker();
      fireExperiment(tracker, { command: "!!@#$%^&*()" });

      const experiments = memory.ls("/experiments/");
      const exp = experiments.find((e) => !e.isDir);
      expect(exp!.path).toContain("01-run");
    });
  });
});
