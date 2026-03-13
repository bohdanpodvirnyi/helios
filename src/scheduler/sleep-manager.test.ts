import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { SleepManager, type SleepRequest } from "./sleep-manager.js";
import type { SleepSession, TriggerExpression } from "./triggers/types.js";

// --- Mocks ---

function createMockScheduler() {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    start: vi.fn(),
    stop: vi.fn(),
    stopAll: vi.fn(),
    cancel: vi.fn(),
    onUserMessage: vi.fn(),
  });
}

function mockOrchestrator(
  overrides: {
    hasSession?: boolean;
    hasProvider?: boolean;
    providerName?: "claude" | "openai";
  } = {},
) {
  const {
    hasSession = true,
    hasProvider = true,
    providerName = "claude",
  } = overrides;
  return {
    currentSession: hasSession
      ? {
          id: "sess-1",
          providerId: providerName,
          providerSessionId: "provider-sess-1",
          createdAt: Date.now(),
          lastActiveAt: Date.now(),
        }
      : null,
    currentProvider: hasProvider ? { name: providerName } : null,
    stateMachine: { transition: vi.fn(), state: "active" },
  } as any;
}

function defaultSleepRequest(
  overrides: Partial<SleepRequest> = {},
): SleepRequest {
  return {
    reason: "Waiting for training to complete",
    expression: { kind: "timer", wakeAt: Date.now() + 60_000 } as TriggerExpression,
    ...overrides,
  };
}

function createSleepManager(
  schedulerOverride?: ReturnType<typeof createMockScheduler>,
  orchestratorOverride?: ReturnType<typeof mockOrchestrator>,
) {
  const scheduler = schedulerOverride ?? createMockScheduler();
  const orchestrator = orchestratorOverride ?? mockOrchestrator();
  const manager = new SleepManager(scheduler as any, orchestrator);
  return { manager, scheduler, orchestrator };
}

describe("SleepManager", () => {
  describe("initial state", () => {
    it("isSleeping returns false initially", () => {
      const { manager } = createSleepManager();
      expect(manager.isSleeping).toBe(false);
    });

    it("currentSleep returns null initially", () => {
      const { manager } = createSleepManager();
      expect(manager.currentSleep).toBeNull();
    });
  });

  describe("sleep()", () => {
    it("creates a SleepSession", async () => {
      const { manager } = createSleepManager();
      const session = await manager.sleep(defaultSleepRequest());
      expect(session).toBeDefined();
      expect(session.id).toBeDefined();
      expect(session.trigger).toBeDefined();
      expect(session.agentState).toBeDefined();
    });

    it("sets isSleeping to true", async () => {
      const { manager } = createSleepManager();
      await manager.sleep(defaultSleepRequest());
      expect(manager.isSleeping).toBe(true);
    });

    it("sets currentSleep to the session", async () => {
      const { manager } = createSleepManager();
      const session = await manager.sleep(defaultSleepRequest());
      expect(manager.currentSleep).toBe(session);
    });

    it("transitions state to sleeping", async () => {
      const { manager, orchestrator } = createSleepManager();
      await manager.sleep(
        defaultSleepRequest({ reason: "Training in progress" }),
      );
      expect(orchestrator.stateMachine.transition).toHaveBeenCalledWith(
        "sleeping",
        "Training in progress",
      );
    });

    it("starts scheduler with session", async () => {
      const { manager, scheduler } = createSleepManager();
      const session = await manager.sleep(defaultSleepRequest());
      expect(scheduler.start).toHaveBeenCalledWith(session);
    });

    it("emits 'sleep' event", async () => {
      const { manager } = createSleepManager();
      const sleepHandler = vi.fn();
      manager.on("sleep", sleepHandler);
      const session = await manager.sleep(defaultSleepRequest());
      expect(sleepHandler).toHaveBeenCalledWith(session);
    });

    it("throws if already sleeping", async () => {
      const { manager } = createSleepManager();
      await manager.sleep(defaultSleepRequest());
      await expect(manager.sleep(defaultSleepRequest())).rejects.toThrow(
        "Already sleeping",
      );
    });

    it("throws if no active session", async () => {
      const { manager } = createSleepManager(
        undefined,
        mockOrchestrator({ hasSession: false }),
      );
      await expect(manager.sleep(defaultSleepRequest())).rejects.toThrow(
        "No active session",
      );
    });

    it("throws if no active provider", async () => {
      const { manager } = createSleepManager(
        undefined,
        mockOrchestrator({ hasProvider: false }),
      );
      await expect(manager.sleep(defaultSleepRequest())).rejects.toThrow(
        "No active session",
      );
    });

    it("creates trigger with correct fields", async () => {
      const { manager } = createSleepManager();
      const expr: TriggerExpression = {
        kind: "timer",
        wakeAt: Date.now() + 120_000,
      };
      const session = await manager.sleep(
        defaultSleepRequest({
          reason: "test reason",
          expression: expr,
          pollIntervalMs: 5000,
        }),
      );
      expect(session.trigger.status).toBe("pending");
      expect(session.trigger.expression).toBe(expr);
      expect(session.trigger.sleepReason).toBe("test reason");
      expect(session.trigger.pollIntervalMs).toBe(5000);
      expect(session.trigger.satisfiedLeaves).toBeInstanceOf(Set);
    });

    it("sets deadline when deadlineMs is provided", async () => {
      const before = Date.now();
      const { manager } = createSleepManager();
      const session = await manager.sleep(
        defaultSleepRequest({ deadlineMs: 60_000 }),
      );
      const after = Date.now();
      expect(session.trigger.deadline).toBeGreaterThanOrEqual(before + 60_000);
      expect(session.trigger.deadline).toBeLessThanOrEqual(after + 60_000);
    });

    it("does not set deadline when deadlineMs is not provided", async () => {
      const { manager } = createSleepManager();
      const session = await manager.sleep(defaultSleepRequest());
      expect(session.trigger.deadline).toBeUndefined();
    });

    it("captures agentState from orchestrator", async () => {
      const orch = mockOrchestrator({ providerName: "openai" });
      const { manager } = createSleepManager(undefined, orch);
      const session = await manager.sleep(defaultSleepRequest());
      expect(session.agentState.sessionId).toBe("sess-1");
      expect(session.agentState.providerName).toBe("openai");
      expect(session.agentState.providerSessionId).toBe("provider-sess-1");
      expect(session.agentState.pendingGoal).toBe(
        "Waiting for training to complete",
      );
    });

    it("captures activeMachines from connectionPool", async () => {
      const { manager } = createSleepManager();
      manager.setConnectionPool({
        getMachineIds: () => ["gpu-1", "gpu-2"],
      } as any);
      const session = await manager.sleep(defaultSleepRequest());
      expect(session.agentState.activeMachines).toEqual(["gpu-1", "gpu-2"]);
    });

    it("uses empty array for activeMachines when no connectionPool set", async () => {
      const { manager } = createSleepManager();
      const session = await manager.sleep(defaultSleepRequest());
      expect(session.agentState.activeMachines).toEqual([]);
    });
  });

  describe("manualWake()", () => {
    it("calls scheduler.onUserMessage", async () => {
      const { manager, scheduler } = createSleepManager();
      await manager.sleep(defaultSleepRequest());
      manager.manualWake();
      expect(scheduler.onUserMessage).toHaveBeenCalled();
    });

    it("does nothing if not sleeping", () => {
      const { manager, scheduler } = createSleepManager();
      manager.manualWake();
      expect(scheduler.onUserMessage).not.toHaveBeenCalled();
    });

    it("stores user message for inclusion in wake message", async () => {
      const { manager, scheduler } = createSleepManager();
      await manager.sleep(defaultSleepRequest());

      const wakeHandler = vi.fn();
      manager.on("wake", wakeHandler);

      // manualWake stores the message, then the scheduler "wake" event triggers handleWake
      manager.manualWake("Please check on the results");

      // Simulate the scheduler emitting "wake"
      const session = manager.currentSleep!;
      session.wakeReason = "user_interrupt";
      session.wokeAt = Date.now();
      scheduler.emit("wake", session, "User sent a message");

      expect(wakeHandler).toHaveBeenCalled();
      const wakeMessage = wakeHandler.mock.calls[0][2] as string;
      expect(wakeMessage).toContain("Please check on the results");
    });
  });

  describe("handleWake (via scheduler wake event)", () => {
    it("clears activeSleep", async () => {
      const { manager, scheduler } = createSleepManager();
      const session = await manager.sleep(defaultSleepRequest());
      session.wakeReason = "trigger_satisfied";
      session.wokeAt = Date.now();
      scheduler.emit("wake", session, "Trigger fired");
      expect(manager.isSleeping).toBe(false);
      expect(manager.currentSleep).toBeNull();
    });

    it("transitions state to active", async () => {
      const { manager, scheduler, orchestrator } = createSleepManager();
      const session = await manager.sleep(defaultSleepRequest());
      orchestrator.stateMachine.transition.mockClear();

      session.wakeReason = "trigger_satisfied";
      session.wokeAt = Date.now();
      scheduler.emit("wake", session, "Trigger fired");

      expect(orchestrator.stateMachine.transition).toHaveBeenCalledWith(
        "active",
        "Trigger fired",
      );
    });

    it("emits 'wake' event with session, reason, and message", async () => {
      const { manager, scheduler } = createSleepManager();
      const wakeHandler = vi.fn();
      manager.on("wake", wakeHandler);

      const session = await manager.sleep(defaultSleepRequest());
      session.wakeReason = "trigger_satisfied";
      session.wokeAt = Date.now();
      scheduler.emit("wake", session, "Trigger fired");

      expect(wakeHandler).toHaveBeenCalledWith(
        session,
        "Trigger fired",
        expect.any(String),
      );
    });

    it("wake handler error does not crash (wrapped in try/catch)", async () => {
      const scheduler = createMockScheduler();
      const orchestrator = mockOrchestrator();
      // Deliberately make transition throw
      orchestrator.stateMachine.transition = vi.fn().mockImplementation(() => {
        throw new Error("transition boom");
      });

      // The constructor wraps the wake handler in try/catch
      const manager = new SleepManager(scheduler as any, orchestrator);

      // Need to make manager sleeping first - but sleep calls transition too
      // Reset to allow sleep to succeed
      orchestrator.stateMachine.transition = vi.fn();
      await manager.sleep(defaultSleepRequest());

      // Now make transition throw on wake
      orchestrator.stateMachine.transition = vi.fn().mockImplementation(() => {
        throw new Error("transition boom");
      });

      const session = manager.currentSleep!;
      session.wakeReason = "trigger_satisfied";
      session.wokeAt = Date.now();

      // Mock stderr.write to capture error output
      const stderrSpy = vi
        .spyOn(process.stderr, "write")
        .mockImplementation(() => true);

      // Should not throw
      expect(() =>
        scheduler.emit("wake", session, "Trigger fired"),
      ).not.toThrow();

      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining("Wake handler error"),
      );
      stderrSpy.mockRestore();
    });
  });

  describe("buildWakeMessage()", () => {
    function makeSleepSession(
      overrides: Partial<SleepSession> = {},
    ): SleepSession {
      return {
        id: "sleep-1",
        trigger: {
          id: "trigger-1",
          status: "satisfied",
          expression: { kind: "timer", wakeAt: 0 },
          createdAt: Date.now(),
          sleepReason: "Training",
          contextSnapshotId: "snap-1",
          satisfiedLeaves: new Set(),
        },
        agentState: {
          sessionId: "sess-1",
          providerName: "claude",
          pendingGoal: "Train the model",
          activeMachines: ["local"],
        },
        createdAt: Date.now() - 300_000, // 5 minutes ago
        wokeAt: Date.now(),
        wakeReason: "trigger_satisfied",
        ...overrides,
      };
    }

    it("includes elapsed time", () => {
      const { manager } = createSleepManager();
      const session = makeSleepSession({
        createdAt: Date.now() - 300_000,
        wokeAt: Date.now(),
      });
      const msg = manager.buildWakeMessage(session);
      expect(msg).toContain("slept 5m 0s");
    });

    it("includes goal", () => {
      const { manager } = createSleepManager();
      const session = makeSleepSession();
      const msg = manager.buildWakeMessage(session);
      expect(msg).toContain("Goal: Train the model");
    });

    it("includes wake reason for trigger_satisfied", () => {
      const { manager } = createSleepManager();
      const session = makeSleepSession({ wakeReason: "trigger_satisfied" });
      const msg = manager.buildWakeMessage(session);
      expect(msg).toContain("Reason: trigger fired");
    });

    it("includes wake reason for user_interrupt", () => {
      const { manager } = createSleepManager();
      const session = makeSleepSession({ wakeReason: "user_interrupt" });
      const msg = manager.buildWakeMessage(session);
      expect(msg).toContain("Reason: user_interrupt");
    });

    it("includes wake reason for deadline", () => {
      const { manager } = createSleepManager();
      const session = makeSleepSession({ wakeReason: "deadline" });
      const msg = manager.buildWakeMessage(session);
      expect(msg).toContain("Reason: deadline");
    });

    it("includes satisfied conditions", () => {
      const { manager } = createSleepManager();
      const session = makeSleepSession();
      session.trigger.satisfiedLeaves = new Set(["root.0", "root.1"]);
      const msg = manager.buildWakeMessage(session);
      expect(msg).toContain("Satisfied conditions: root.0, root.1");
    });

    it("does not include satisfied conditions when empty", () => {
      const { manager } = createSleepManager();
      const session = makeSleepSession();
      session.trigger.satisfiedLeaves = new Set();
      const msg = manager.buildWakeMessage(session);
      expect(msg).not.toContain("Satisfied conditions");
    });

    it("includes active tasks when executor set", () => {
      const { manager } = createSleepManager();
      manager.setExecutor({
        getBackgroundProcesses: () => [
          { machineId: "gpu-1", pid: 1234, command: "python train.py --epochs 100" },
        ],
      } as any);
      const session = makeSleepSession();
      const msg = manager.buildWakeMessage(session);
      expect(msg).toContain("Active tasks:");
      expect(msg).toContain("gpu-1:1234");
      expect(msg).toContain("python train.py --epochs 100");
    });

    it("does not include active tasks section when executor has no processes", () => {
      const { manager } = createSleepManager();
      manager.setExecutor({
        getBackgroundProcesses: () => [],
      } as any);
      const session = makeSleepSession();
      const msg = manager.buildWakeMessage(session);
      expect(msg).not.toContain("Active tasks:");
    });

    it("does not include active tasks when executor not set", () => {
      const { manager } = createSleepManager();
      const session = makeSleepSession();
      const msg = manager.buildWakeMessage(session);
      expect(msg).not.toContain("Active tasks:");
    });

    it("includes latest metrics when metricStore set", () => {
      const { manager } = createSleepManager();
      manager.setMetricStore({
        getLatestPerMetric: () => ({ loss: 0.23, accuracy: 0.95 }),
      } as any);
      const session = makeSleepSession();
      const msg = manager.buildWakeMessage(session);
      expect(msg).toContain("Latest metrics:");
      expect(msg).toContain("loss: 0.23");
      expect(msg).toContain("accuracy: 0.95");
    });

    it("does not include metrics section when metricStore returns empty", () => {
      const { manager } = createSleepManager();
      manager.setMetricStore({
        getLatestPerMetric: () => ({}),
      } as any);
      const session = makeSleepSession();
      const msg = manager.buildWakeMessage(session);
      expect(msg).not.toContain("Latest metrics:");
    });

    it("does not include metrics when metricStore not set", () => {
      const { manager } = createSleepManager();
      const session = makeSleepSession();
      const msg = manager.buildWakeMessage(session);
      expect(msg).not.toContain("Latest metrics:");
    });

    it("limits metrics to first 10 entries", () => {
      const { manager } = createSleepManager();
      const manyMetrics: Record<string, number> = {};
      for (let i = 0; i < 15; i++) {
        manyMetrics[`metric_${i}`] = i;
      }
      manager.setMetricStore({
        getLatestPerMetric: () => manyMetrics,
      } as any);
      const session = makeSleepSession();
      const msg = manager.buildWakeMessage(session);
      // Should show first 10, not all 15
      expect(msg).toContain("metric_9");
      expect(msg).not.toContain("metric_10");
    });

    it("ends with 'Continue working toward your goal.'", () => {
      const { manager } = createSleepManager();
      const session = makeSleepSession();
      const msg = manager.buildWakeMessage(session);
      expect(msg).toContain("Continue working toward your goal.");
    });

    it("uses Date.now() when wokeAt not set", () => {
      const frozen = 1_700_000_300_000;
      vi.spyOn(Date, "now").mockReturnValue(frozen);
      const { manager } = createSleepManager();
      const session = makeSleepSession({
        createdAt: 1_700_000_000_000,
        wokeAt: undefined,
      });
      const msg = manager.buildWakeMessage(session);
      // 300 seconds = 5m 0s
      expect(msg).toContain("slept 5m 0s");
      vi.restoreAllMocks();
    });

    it("truncates long commands in active tasks", () => {
      const { manager } = createSleepManager();
      const longCmd = "python " + "a".repeat(100) + ".py";
      manager.setExecutor({
        getBackgroundProcesses: () => [
          { machineId: "local", pid: 999, command: longCmd },
        ],
      } as any);
      const session = makeSleepSession();
      const msg = manager.buildWakeMessage(session);
      // command.slice(0, 60) is used
      const taskLine = msg.split("\n").find((l) => l.includes("local:999"));
      expect(taskLine).toBeDefined();
      expect(taskLine!.includes(longCmd)).toBe(false);
    });
  });

  describe("setExecutor / setConnectionPool / setMetricStore", () => {
    it("setExecutor wires the dependency", async () => {
      const { manager } = createSleepManager();
      const executor = { getBackgroundProcesses: vi.fn().mockReturnValue([]) } as any;
      manager.setExecutor(executor);
      const session = await manager.sleep(defaultSleepRequest());
      // buildWakeMessage should use the executor
      session.wakeReason = "trigger_satisfied";
      session.wokeAt = Date.now();
      manager.buildWakeMessage(session);
      expect(executor.getBackgroundProcesses).toHaveBeenCalled();
    });

    it("setConnectionPool wires the dependency for activeMachines", async () => {
      const { manager } = createSleepManager();
      manager.setConnectionPool({
        getMachineIds: () => ["m1", "m2", "m3"],
      } as any);
      const session = await manager.sleep(defaultSleepRequest());
      expect(session.agentState.activeMachines).toEqual(["m1", "m2", "m3"]);
    });

    it("setMetricStore wires the dependency", async () => {
      const { manager } = createSleepManager();
      const store = {
        getLatestPerMetric: vi.fn().mockReturnValue({ loss: 0.1 }),
      } as any;
      manager.setMetricStore(store);
      const session = await manager.sleep(defaultSleepRequest());
      session.wakeReason = "trigger_satisfied";
      session.wokeAt = Date.now();
      const msg = manager.buildWakeMessage(session);
      expect(store.getLatestPerMetric).toHaveBeenCalled();
      expect(msg).toContain("loss: 0.1");
    });
  });

  describe("wake event integration", () => {
    it("handleWake clears pending user message after use", async () => {
      const { manager, scheduler } = createSleepManager();
      await manager.sleep(defaultSleepRequest());

      const wakeHandler = vi.fn();
      manager.on("wake", wakeHandler);

      manager.manualWake("first message");
      const session1 = manager.currentSleep!;
      session1.wakeReason = "user_interrupt";
      session1.wokeAt = Date.now();
      scheduler.emit("wake", session1, "User sent a message");

      const msg1 = wakeHandler.mock.calls[0][2] as string;
      expect(msg1).toContain("first message");

      // Sleep again and wake without manual message
      wakeHandler.mockClear();
      const session2 = await manager.sleep(defaultSleepRequest());
      session2.wakeReason = "trigger_satisfied";
      session2.wokeAt = Date.now();
      scheduler.emit("wake", session2, "Timer");

      const msg2 = wakeHandler.mock.calls[0][2] as string;
      expect(msg2).not.toContain("first message");
      expect(msg2).not.toContain("User message:");
    });

    it("emits wake event with correct session reference", async () => {
      const { manager, scheduler } = createSleepManager();
      const wakeHandler = vi.fn();
      manager.on("wake", wakeHandler);

      const session = await manager.sleep(defaultSleepRequest());
      session.wakeReason = "deadline";
      session.wokeAt = Date.now();
      scheduler.emit("wake", session, "Deadline reached");

      expect(wakeHandler.mock.calls[0][0]).toBe(session);
      expect(wakeHandler.mock.calls[0][1]).toBe("Deadline reached");
    });
  });
});
