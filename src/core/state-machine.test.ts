import { describe, it, expect, vi } from "vitest";
import { AgentStateMachine } from "./state-machine.js";

describe("AgentStateMachine", () => {
  it("starts in idle state", () => {
    const sm = new AgentStateMachine();
    expect(sm.state).toBe("idle");
  });

  it("transitions idle → active", () => {
    const sm = new AgentStateMachine();
    sm.transition("active", "Session started");
    expect(sm.state).toBe("active");
  });

  it("records transitions in history", () => {
    const sm = new AgentStateMachine();
    sm.transition("active", "test");
    expect(sm.history).toHaveLength(1);
    expect(sm.history[0]).toMatchObject({
      from: "idle",
      to: "active",
      reason: "test",
    });
    expect(sm.history[0].timestamp).toBeGreaterThan(0);
  });

  it("throws on invalid transition", () => {
    const sm = new AgentStateMachine();
    expect(() => sm.transition("sleeping", "nope")).toThrow(
      "Invalid state transition: idle → sleeping",
    );
  });

  it("allows active → sleeping", () => {
    const sm = new AgentStateMachine();
    sm.transition("active", "go");
    sm.transition("sleeping", "waiting for trigger");
    expect(sm.state).toBe("sleeping");
  });

  it("allows sleeping → active", () => {
    const sm = new AgentStateMachine();
    sm.transition("active", "go");
    sm.transition("sleeping", "sleep");
    sm.transition("active", "woke up");
    expect(sm.state).toBe("active");
  });

  it("allows active → error → active", () => {
    const sm = new AgentStateMachine();
    sm.transition("active", "go");
    sm.transition("error", "crashed");
    sm.transition("active", "recovered");
    expect(sm.state).toBe("active");
  });

  it("allows error → idle", () => {
    const sm = new AgentStateMachine();
    sm.transition("active", "go");
    sm.transition("error", "crash");
    sm.transition("idle", "reset");
    expect(sm.state).toBe("idle");
  });

  it("disallows idle → sleeping", () => {
    const sm = new AgentStateMachine();
    expect(() => sm.transition("sleeping", "")).toThrow();
  });

  it("disallows sleeping → idle", () => {
    const sm = new AgentStateMachine();
    sm.transition("active", "go");
    sm.transition("sleeping", "sleep");
    expect(() => sm.transition("idle", "")).toThrow();
  });

  it("fires listeners on transition", () => {
    const sm = new AgentStateMachine();
    const listener = vi.fn();
    sm.onTransition(listener);

    sm.transition("active", "go");
    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith("active", expect.objectContaining({
      from: "idle",
      to: "active",
      reason: "go",
    }));
  });

  it("unsubscribes listeners", () => {
    const sm = new AgentStateMachine();
    const listener = vi.fn();
    const unsub = sm.onTransition(listener);

    sm.transition("active", "go");
    expect(listener).toHaveBeenCalledOnce();

    unsub();
    sm.transition("sleeping", "sleep");
    expect(listener).toHaveBeenCalledOnce(); // not called again
  });

  it("accumulates history across transitions", () => {
    const sm = new AgentStateMachine();
    sm.transition("active", "a");
    sm.transition("sleeping", "b");
    sm.transition("active", "c");
    expect(sm.history).toHaveLength(3);
  });
});
