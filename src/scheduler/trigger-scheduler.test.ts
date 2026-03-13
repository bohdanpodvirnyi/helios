import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TriggerScheduler } from "./trigger-scheduler.js";
import { evaluateTimer } from "./triggers/timer.js";
import { evaluateProcessExit } from "./triggers/process-exit.js";
import { evaluateFile } from "./triggers/file.js";
import { evaluateMetric } from "./triggers/metric.js";
import { evaluateResource } from "./triggers/resource.js";
import type {
  SleepSession,
  TriggerExpression,
  Trigger,
  CompositeTrigger,
} from "./triggers/types.js";

// --- Mocks ---

vi.mock("./triggers/timer.js", () => ({
  evaluateTimer: vi.fn().mockReturnValue(false),
}));
vi.mock("./triggers/process-exit.js", () => ({
  evaluateProcessExit: vi.fn().mockResolvedValue(false),
}));
vi.mock("./triggers/file.js", () => ({
  evaluateFile: vi.fn().mockResolvedValue(false),
}));
vi.mock("./triggers/metric.js", () => ({
  evaluateMetric: vi.fn().mockResolvedValue(false),
}));
vi.mock("./triggers/resource.js", () => ({
  evaluateResource: vi.fn().mockResolvedValue(false),
}));
vi.mock("./ssh-batcher.js", () => ({
  SSHBatcher: class MockSSHBatcher {
    enqueue = vi.fn();
    flush = vi.fn().mockResolvedValue(undefined);
  },
}));

// --- Helpers ---

function mockSleepSession(
  expression: TriggerExpression,
  overrides?: Partial<{
    id: string;
    triggerId: string;
    deadline: number;
    pollIntervalMs: number;
  }>,
): SleepSession {
  return {
    id: overrides?.id ?? "sleep-1",
    trigger: {
      id: overrides?.triggerId ?? "trig-1",
      status: "pending",
      expression,
      createdAt: Date.now(),
      sleepReason: "test",
      contextSnapshotId: "sess-1",
      satisfiedLeaves: new Set(),
      deadline: overrides?.deadline,
      pollIntervalMs: overrides?.pollIntervalMs,
    },
    agentState: {
      sessionId: "sess-1",
      providerName: "claude" as const,
      pendingGoal: "test goal",
      activeMachines: [],
    },
    createdAt: Date.now(),
  };
}

function fakePool(): any {
  return {
    exec: vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 }),
    get: vi.fn(),
    release: vi.fn(),
  };
}

// --- Tests ---

describe("TriggerScheduler", () => {
  let scheduler: TriggerScheduler;
  let pool: any;

  beforeEach(() => {
    vi.useFakeTimers();
    pool = fakePool();
    scheduler = new TriggerScheduler(pool);
    // Reset all evaluator mocks to default (false)
    vi.mocked(evaluateTimer).mockReturnValue(false);
    vi.mocked(evaluateProcessExit).mockResolvedValue(false);
    vi.mocked(evaluateFile).mockResolvedValue(false);
    vi.mocked(evaluateMetric).mockResolvedValue(false);
    vi.mocked(evaluateResource).mockResolvedValue(false);
  });

  afterEach(() => {
    scheduler.stopAll();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // --- Lifecycle ---

  it("start begins polling (schedules evaluation cycle)", () => {
    const session = mockSleepSession({ kind: "timer", wakeAt: Date.now() + 60_000 });
    scheduler.start(session);
    expect(session.trigger.status).toBe("active");
    expect(scheduler.activeSessions).toHaveLength(1);
  });

  it("stopAll clears all sessions and stops the timer", () => {
    const session = mockSleepSession({ kind: "timer", wakeAt: Date.now() + 60_000 });
    scheduler.start(session);
    scheduler.stopAll();
    expect(scheduler.activeSessions).toHaveLength(0);
  });

  it("cancel removes a specific session", () => {
    const s1 = mockSleepSession({ kind: "timer", wakeAt: Date.now() + 60_000 }, { id: "s1" });
    const s2 = mockSleepSession({ kind: "timer", wakeAt: Date.now() + 60_000 }, { id: "s2" });
    scheduler.start(s1);
    scheduler.start(s2);
    expect(scheduler.activeSessions).toHaveLength(2);
    scheduler.cancel("s1");
    expect(scheduler.activeSessions).toHaveLength(1);
    expect(s1.trigger.status).toBe("cancelled");
  });

  // --- Condition Evaluation ---

  it("evaluates timer condition", async () => {
    vi.mocked(evaluateTimer).mockReturnValue(true);
    const session = mockSleepSession({ kind: "timer", wakeAt: Date.now() - 1000 });
    const wakeSpy = vi.fn();
    scheduler.on("wake", wakeSpy);
    scheduler.start(session);

    await vi.advanceTimersByTimeAsync(1100);

    expect(evaluateTimer).toHaveBeenCalled();
    expect(wakeSpy).toHaveBeenCalledWith(
      expect.objectContaining({ id: "sleep-1" }),
      expect.any(String),
    );
  });

  it("evaluates process_exit condition", async () => {
    vi.mocked(evaluateProcessExit).mockResolvedValue(true);
    const session = mockSleepSession({
      kind: "process_exit",
      machineId: "m-1",
      pid: 1234,
    });
    const wakeSpy = vi.fn();
    scheduler.on("wake", wakeSpy);
    scheduler.start(session);

    await vi.advanceTimersByTimeAsync(1100);

    expect(evaluateProcessExit).toHaveBeenCalled();
    expect(wakeSpy).toHaveBeenCalled();
  });

  it("evaluates file condition", async () => {
    vi.mocked(evaluateFile).mockResolvedValue(true);
    const session = mockSleepSession({
      kind: "file",
      machineId: "m-1",
      path: "/tmp/output.csv",
      mode: "exists",
    });
    const wakeSpy = vi.fn();
    scheduler.on("wake", wakeSpy);
    scheduler.start(session);

    await vi.advanceTimersByTimeAsync(1100);

    expect(evaluateFile).toHaveBeenCalled();
    expect(wakeSpy).toHaveBeenCalled();
  });

  it("evaluates metric condition", async () => {
    vi.mocked(evaluateMetric).mockResolvedValue(true);
    const session = mockSleepSession({
      kind: "metric",
      machineId: "m-1",
      source: { type: "json_file", path: "/tmp/metrics.json" },
      field: "loss",
      comparator: "<",
      threshold: 0.1,
    });
    const wakeSpy = vi.fn();
    scheduler.on("wake", wakeSpy);
    scheduler.start(session);

    await vi.advanceTimersByTimeAsync(1100);

    expect(evaluateMetric).toHaveBeenCalled();
    expect(wakeSpy).toHaveBeenCalled();
  });

  it("evaluates resource condition", async () => {
    vi.mocked(evaluateResource).mockResolvedValue(true);
    const session = mockSleepSession({
      kind: "resource",
      machineId: "m-1",
      resource: "gpu_util",
      comparator: "<",
      threshold: 10,
    });
    const wakeSpy = vi.fn();
    scheduler.on("wake", wakeSpy);
    scheduler.start(session);

    await vi.advanceTimersByTimeAsync(1100);

    expect(evaluateResource).toHaveBeenCalled();
    expect(wakeSpy).toHaveBeenCalled();
  });

  it("handles user_message condition (event-driven, always false in poll)", async () => {
    const session = mockSleepSession({ kind: "user_message" });
    const wakeSpy = vi.fn();
    scheduler.on("wake", wakeSpy);
    scheduler.start(session);

    // After polling cycle, should NOT wake (user_message returns false in evaluateCondition)
    await vi.advanceTimersByTimeAsync(1100);
    expect(wakeSpy).not.toHaveBeenCalled();
    expect(scheduler.activeSessions).toHaveLength(1);
  });

  it("onUserMessage satisfies user_message condition and wakes session", () => {
    const session = mockSleepSession({ kind: "user_message" });
    const wakeSpy = vi.fn();
    scheduler.on("wake", wakeSpy);
    scheduler.start(session);

    scheduler.onUserMessage();

    expect(wakeSpy).toHaveBeenCalledWith(
      expect.objectContaining({ id: "sleep-1", wakeReason: "user_interrupt" }),
      "User sent a message",
    );
    expect(session.trigger.status).toBe("satisfied");
    expect(scheduler.activeSessions).toHaveLength(0);
  });

  // --- Composite Logic ---

  it("AND composite: requires all children satisfied", async () => {
    vi.mocked(evaluateTimer).mockReturnValue(true);
    vi.mocked(evaluateFile).mockResolvedValue(false); // one child false

    const session = mockSleepSession({
      op: "and",
      children: [
        { kind: "timer", wakeAt: Date.now() - 1000 },
        { kind: "file", machineId: "m-1", path: "/tmp/out", mode: "exists" },
      ],
    } as CompositeTrigger);
    const wakeSpy = vi.fn();
    scheduler.on("wake", wakeSpy);
    scheduler.start(session);

    await vi.advanceTimersByTimeAsync(1100);

    // Should NOT wake because file condition is false
    expect(wakeSpy).not.toHaveBeenCalled();
  });

  it("AND composite: wakes when all children are satisfied", async () => {
    vi.mocked(evaluateTimer).mockReturnValue(true);
    vi.mocked(evaluateFile).mockResolvedValue(true);

    const session = mockSleepSession({
      op: "and",
      children: [
        { kind: "timer", wakeAt: Date.now() - 1000 },
        { kind: "file", machineId: "m-1", path: "/tmp/out", mode: "exists" },
      ],
    } as CompositeTrigger);
    const wakeSpy = vi.fn();
    scheduler.on("wake", wakeSpy);
    scheduler.start(session);

    await vi.advanceTimersByTimeAsync(1100);

    expect(wakeSpy).toHaveBeenCalled();
  });

  it("OR composite: any child satisfies", async () => {
    vi.mocked(evaluateTimer).mockReturnValue(false);
    vi.mocked(evaluateFile).mockResolvedValue(true); // only file is true

    const session = mockSleepSession({
      op: "or",
      children: [
        { kind: "timer", wakeAt: Date.now() + 60_000 },
        { kind: "file", machineId: "m-1", path: "/tmp/out", mode: "exists" },
      ],
    } as CompositeTrigger);
    const wakeSpy = vi.fn();
    scheduler.on("wake", wakeSpy);
    scheduler.start(session);

    await vi.advanceTimersByTimeAsync(1100);

    expect(wakeSpy).toHaveBeenCalled();
  });

  it("nested composite (AND within OR)", async () => {
    vi.mocked(evaluateTimer).mockReturnValue(true);
    vi.mocked(evaluateFile).mockResolvedValue(false);
    vi.mocked(evaluateResource).mockResolvedValue(true);

    const session = mockSleepSession({
      op: "or",
      children: [
        {
          op: "and",
          children: [
            { kind: "timer", wakeAt: Date.now() - 1000 },
            { kind: "file", machineId: "m-1", path: "/tmp/x", mode: "exists" },
          ],
        } as CompositeTrigger,
        { kind: "resource", machineId: "m-1", resource: "gpu_util", comparator: "<", threshold: 5 },
      ],
    } as CompositeTrigger);
    const wakeSpy = vi.fn();
    scheduler.on("wake", wakeSpy);
    scheduler.start(session);

    await vi.advanceTimersByTimeAsync(1100);

    // AND branch fails (file=false), but resource=true satisfies the OR
    expect(wakeSpy).toHaveBeenCalled();
  });

  // --- Wake Behavior ---

  it('emits "wake" when trigger satisfied', async () => {
    vi.mocked(evaluateTimer).mockReturnValue(true);
    const session = mockSleepSession({ kind: "timer", wakeAt: Date.now() - 1000 });
    const wakeSpy = vi.fn();
    scheduler.on("wake", wakeSpy);
    scheduler.start(session);

    await vi.advanceTimersByTimeAsync(1100);

    expect(wakeSpy).toHaveBeenCalledTimes(1);
  });

  it('sets trigger status to "satisfied"', async () => {
    vi.mocked(evaluateTimer).mockReturnValue(true);
    const session = mockSleepSession({ kind: "timer", wakeAt: Date.now() - 1000 });
    scheduler.start(session);

    await vi.advanceTimersByTimeAsync(1100);

    expect(session.trigger.status).toBe("satisfied");
  });

  it("records satisfiedAt timestamp", async () => {
    vi.mocked(evaluateTimer).mockReturnValue(true);
    const session = mockSleepSession({ kind: "timer", wakeAt: Date.now() - 1000 });
    scheduler.start(session);

    await vi.advanceTimersByTimeAsync(1100);

    expect(session.trigger.satisfiedAt).toBeTypeOf("number");
    expect(session.trigger.satisfiedAt).toBeGreaterThan(0);
  });

  it("records satisfied leaves", async () => {
    vi.mocked(evaluateTimer).mockReturnValue(true);
    const session = mockSleepSession({ kind: "timer", wakeAt: Date.now() - 1000 });
    scheduler.start(session);

    await vi.advanceTimersByTimeAsync(1100);

    expect(session.trigger.satisfiedLeaves.size).toBeGreaterThan(0);
    expect(session.trigger.satisfiedLeaves.has("root")).toBe(true);
  });

  // --- Deadline ---

  it("handles deadline expiry", async () => {
    const now = Date.now();
    const session = mockSleepSession(
      { kind: "timer", wakeAt: now + 999_999 },
      { deadline: now + 500 },
    );
    const wakeSpy = vi.fn();
    scheduler.on("wake", wakeSpy);
    scheduler.start(session);

    await vi.advanceTimersByTimeAsync(1100);

    expect(wakeSpy).toHaveBeenCalled();
    expect(session.trigger.status).toBe("expired");
  });

  it('emits "wake" with deadline reason on expiry', async () => {
    const now = Date.now();
    const session = mockSleepSession(
      { kind: "timer", wakeAt: now + 999_999 },
      { deadline: now + 500 },
    );
    const wakeSpy = vi.fn();
    scheduler.on("wake", wakeSpy);
    scheduler.start(session);

    await vi.advanceTimersByTimeAsync(1100);

    expect(wakeSpy).toHaveBeenCalledWith(
      expect.objectContaining({ wakeReason: "deadline" }),
      "Deadline reached",
    );
  });

  // --- Error Handling ---

  it("handles evaluation errors gracefully (does not crash)", async () => {
    vi.mocked(evaluateTimer).mockImplementation(() => {
      throw new Error("evaluation boom");
    });
    const session = mockSleepSession({ kind: "timer", wakeAt: Date.now() - 1000 });
    const errorSpy = vi.fn();
    scheduler.on("error", errorSpy);
    scheduler.start(session);

    await vi.advanceTimersByTimeAsync(1100);

    expect(errorSpy).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ id: "trig-1" }),
    );
    // Session should still be active (not removed on error)
    expect(scheduler.activeSessions).toHaveLength(1);
  });

  it("sets lastError on evaluation failure", async () => {
    vi.mocked(evaluateTimer).mockImplementation(() => {
      throw new Error("disk full");
    });
    const session = mockSleepSession({ kind: "timer", wakeAt: Date.now() - 1000 });
    scheduler.on("error", () => {}); // prevent unhandled
    scheduler.start(session);

    await vi.advanceTimersByTimeAsync(1100);

    expect(session.trigger.lastError).toBe("disk full");
  });

  // --- Polling & Timing ---

  it("updates lastEvaluatedAt after each evaluation", async () => {
    const session = mockSleepSession({ kind: "timer", wakeAt: Date.now() + 60_000 });
    scheduler.start(session);

    expect(session.trigger.lastEvaluatedAt).toBeUndefined();

    await vi.advanceTimersByTimeAsync(1100);

    expect(session.trigger.lastEvaluatedAt).toBeTypeOf("number");
  });

  it("does not re-evaluate after satisfaction (session removed)", async () => {
    vi.mocked(evaluateTimer).mockReturnValue(true);
    const session = mockSleepSession({ kind: "timer", wakeAt: Date.now() - 1000 });
    scheduler.on("wake", () => {});
    scheduler.start(session);

    await vi.advanceTimersByTimeAsync(1100);

    expect(session.trigger.status).toBe("satisfied");

    // Clear call count
    vi.mocked(evaluateTimer).mockClear();

    // Advance further — should NOT evaluate again
    await vi.advanceTimersByTimeAsync(5000);

    expect(evaluateTimer).not.toHaveBeenCalled();
  });

  it("empty AND expression evaluates to true (vacuous truth)", async () => {
    const session = mockSleepSession({
      op: "and",
      children: [],
    } as CompositeTrigger);
    const wakeSpy = vi.fn();
    scheduler.on("wake", wakeSpy);
    scheduler.start(session);

    await vi.advanceTimersByTimeAsync(1100);

    expect(wakeSpy).toHaveBeenCalled();
    expect(session.trigger.status).toBe("satisfied");
  });

  it("empty OR expression evaluates to false (no child to satisfy)", async () => {
    const session = mockSleepSession({
      op: "or",
      children: [],
    } as CompositeTrigger);
    const wakeSpy = vi.fn();
    scheduler.on("wake", wakeSpy);
    scheduler.start(session);

    await vi.advanceTimersByTimeAsync(1100);

    expect(wakeSpy).not.toHaveBeenCalled();
  });

  // --- Latching (satisfied leaves persist for AND) ---

  it("latches satisfied leaves for partial AND tracking", async () => {
    // First cycle: timer satisfied, file not
    vi.mocked(evaluateTimer).mockReturnValue(true);
    vi.mocked(evaluateFile).mockResolvedValue(false);

    const session = mockSleepSession({
      op: "and",
      children: [
        { kind: "timer", wakeAt: Date.now() - 1000 },
        { kind: "file", machineId: "m-1", path: "/tmp/x", mode: "exists" },
      ],
    } as CompositeTrigger);
    const wakeSpy = vi.fn();
    scheduler.on("wake", wakeSpy);
    scheduler.start(session);

    await vi.advanceTimersByTimeAsync(1100);

    // Timer should be latched
    expect(session.trigger.satisfiedLeaves.has("root.0")).toBe(true);
    expect(wakeSpy).not.toHaveBeenCalled();

    // Second cycle: file now satisfied too
    vi.mocked(evaluateFile).mockResolvedValue(true);

    await vi.advanceTimersByTimeAsync(1100);

    expect(wakeSpy).toHaveBeenCalled();
    expect(session.trigger.status).toBe("satisfied");
  });

  // --- trigger-update event ---

  it('emits "trigger-update" after each evaluation cycle', async () => {
    const session = mockSleepSession({ kind: "timer", wakeAt: Date.now() + 60_000 });
    const updateSpy = vi.fn();
    scheduler.on("trigger-update", updateSpy);
    scheduler.start(session);

    await vi.advanceTimersByTimeAsync(1100);

    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ id: "trig-1" }),
    );
  });

  // --- Multiple sessions ---

  it("handles multiple concurrent sessions independently", async () => {
    vi.mocked(evaluateTimer).mockReturnValue(true);
    vi.mocked(evaluateFile).mockResolvedValue(false);

    const s1 = mockSleepSession(
      { kind: "timer", wakeAt: Date.now() - 1000 },
      { id: "s1", triggerId: "t1" },
    );
    const s2 = mockSleepSession(
      { kind: "file", machineId: "m-1", path: "/tmp/x", mode: "exists" },
      { id: "s2", triggerId: "t2" },
    );
    const wakeSpy = vi.fn();
    scheduler.on("wake", wakeSpy);
    scheduler.start(s1);
    scheduler.start(s2);

    await vi.advanceTimersByTimeAsync(1100);

    // Only timer session should wake
    expect(wakeSpy).toHaveBeenCalledTimes(1);
    expect(wakeSpy).toHaveBeenCalledWith(
      expect.objectContaining({ id: "s1" }),
      expect.any(String),
    );
    expect(scheduler.activeSessions).toHaveLength(1);
    expect(scheduler.activeSessions[0].id).toBe("s2");
  });

  it("stops polling when all sessions are resolved", async () => {
    vi.mocked(evaluateTimer).mockReturnValue(true);
    const session = mockSleepSession({ kind: "timer", wakeAt: Date.now() - 1000 });
    scheduler.on("wake", () => {});
    scheduler.start(session);

    await vi.advanceTimersByTimeAsync(1100);

    expect(scheduler.activeSessions).toHaveLength(0);

    // Evaluator should not be called again after all sessions resolved
    vi.mocked(evaluateTimer).mockClear();
    await vi.advanceTimersByTimeAsync(5000);
    expect(evaluateTimer).not.toHaveBeenCalled();
  });

  it("onUserMessage wakes all sleeping sessions", () => {
    const s1 = mockSleepSession({ kind: "user_message" }, { id: "s1" });
    const s2 = mockSleepSession({ kind: "timer", wakeAt: Date.now() + 60_000 }, { id: "s2" });
    const wakeSpy = vi.fn();
    scheduler.on("wake", wakeSpy);
    scheduler.start(s1);
    scheduler.start(s2);

    scheduler.onUserMessage();

    expect(wakeSpy).toHaveBeenCalledTimes(2);
    expect(scheduler.activeSessions).toHaveLength(0);
  });

  it("activeSessions returns current sessions", () => {
    const s1 = mockSleepSession({ kind: "timer", wakeAt: Date.now() + 60_000 }, { id: "s1" });
    expect(scheduler.activeSessions).toHaveLength(0);
    scheduler.start(s1);
    expect(scheduler.activeSessions).toHaveLength(1);
    expect(scheduler.activeSessions[0].id).toBe("s1");
  });

  it("sets wakeReason to trigger_satisfied on normal satisfaction", async () => {
    vi.mocked(evaluateTimer).mockReturnValue(true);
    const session = mockSleepSession({ kind: "timer", wakeAt: Date.now() - 1000 });
    scheduler.on("wake", () => {});
    scheduler.start(session);

    await vi.advanceTimersByTimeAsync(1100);

    expect(session.wakeReason).toBe("trigger_satisfied");
    expect(session.wokeAt).toBeTypeOf("number");
  });
});
