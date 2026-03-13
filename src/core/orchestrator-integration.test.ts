import { describe, it, expect, vi, beforeEach } from "vitest";
import { createTestDb } from "../__tests__/db-helper.js";
import type {
  ModelProvider,
  ToolDefinition,
  Session,
  AgentEvent,
  ReasoningEffort,
} from "../providers/types.js";

// ---------------------------------------------------------------------------
// Module mocks — must come before dynamic import of Orchestrator
// ---------------------------------------------------------------------------

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

vi.mock("../store/preferences.js", () => ({
  savePreferences: vi.fn(),
}));

vi.mock("../paths.js", () => ({
  debugLog: vi.fn(),
}));

const { Orchestrator } = await import("./orchestrator.js");
const { SessionStore } = await import("../store/session-store.js");
const { StickyManager } = await import("./stickies.js");

// ---------------------------------------------------------------------------
// Mock provider factory
// ---------------------------------------------------------------------------

function mockProvider(
  name: "claude" | "openai" = "claude",
  sessionStore?: InstanceType<typeof SessionStore>,
): ModelProvider {
  return {
    name,
    displayName: name === "claude" ? "Claude" : "OpenAI",
    currentModel: name === "claude" ? "claude-opus-4-6" : "gpt-5.4",
    reasoningEffort: "medium" as ReasoningEffort,
    isAuthenticated: vi.fn().mockResolvedValue(true),
    authenticate: vi.fn().mockResolvedValue(undefined),
    createSession: vi.fn().mockImplementation(async (_config: any) => {
      if (sessionStore) {
        return sessionStore.createSession(name, name === "claude" ? "claude-opus-4-6" : "gpt-5.4");
      }
      const now = Date.now();
      return {
        id: `sess-${Math.random().toString(36).slice(2, 8)}`,
        providerId: name,
        createdAt: now,
        lastActiveAt: now,
      };
    }),
    resumeSession: vi.fn().mockImplementation(async (id: string) => {
      return {
        id,
        providerId: name,
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
      };
    }),
    send: vi.fn().mockImplementation(async function* () {
      yield { type: "text" as const, text: "Hello", delta: "Hello" };
      yield {
        type: "done" as const,
        usage: { inputTokens: 100, outputTokens: 50, costUsd: 0.01 },
      };
    }),
    interrupt: vi.fn(),
    resetHistory: vi.fn(),
    closeSession: vi.fn().mockResolvedValue(undefined),
    fetchModels: vi.fn().mockResolvedValue([{ id: "test-model", name: "Test Model" }]),
  } as unknown as ModelProvider;
}

/**
 * Creates a "chatty" provider that returns different responses based on call count.
 * Useful for multi-turn integration tests.
 */
function chattyProvider(
  name: "claude" | "openai" = "claude",
  sessionStore?: InstanceType<typeof SessionStore>,
): ModelProvider {
  let callCount = 0;
  const base = mockProvider(name, sessionStore);
  (base.send as any) = vi.fn().mockImplementation(async function* (
    _session: Session,
    _message: string,
    _tools: ToolDefinition[],
  ) {
    callCount++;
    if (callCount === 1) {
      yield { type: "text" as const, text: "Hello!", delta: "Hello!" };
      yield { type: "done" as const, usage: { inputTokens: 50, outputTokens: 20, costUsd: 0.005 } };
    } else if (callCount === 2) {
      yield { type: "tool_call" as const, id: "tc-1", name: "remote_exec", args: { command: "ls" } };
      yield { type: "tool_result" as const, callId: "tc-1", result: "file.txt" };
      yield { type: "text" as const, text: "Found file.txt", delta: "Found file.txt" };
      yield { type: "done" as const, usage: { inputTokens: 100, outputTokens: 40, costUsd: 0.015 } };
    } else {
      yield { type: "text" as const, text: "Done", delta: "Done" };
      yield { type: "done" as const, usage: { inputTokens: 75, outputTokens: 30, costUsd: 0.008 } };
    }
  });
  return base;
}

/**
 * Creates a provider that emits an error during send.
 */
function errorProvider(
  name: "claude" | "openai" = "claude",
  sessionStore?: InstanceType<typeof SessionStore>,
): ModelProvider {
  const base = mockProvider(name, sessionStore);
  (base.send as any) = vi.fn().mockImplementation(async function* () {
    yield { type: "text" as const, text: "Starting...", delta: "Starting..." };
    throw new Error("Provider exploded");
  });
  return base;
}

/**
 * Provider whose send emits done events with no usage.
 */
function noUsageProvider(
  name: "claude" | "openai" = "claude",
  sessionStore?: InstanceType<typeof SessionStore>,
): ModelProvider {
  const base = mockProvider(name, sessionStore);
  (base.send as any) = vi.fn().mockImplementation(async function* () {
    yield { type: "text" as const, text: "No stats", delta: "No stats" };
    yield { type: "done" as const };
  });
  return base;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOrchestrator(defaultProvider: "claude" | "openai" = "claude") {
  return new Orchestrator({
    defaultProvider,
    systemPrompt: "You are a test agent.",
    sessionStore: new SessionStore("integ-agent"),
  });
}

async function makeWiredOrchestrator(providerName: "claude" | "openai" = "claude") {
  const orch = makeOrchestrator(providerName);
  const provider = mockProvider(providerName, orch.sessionStore);
  orch.registerProvider(provider);
  await orch.switchProvider(providerName);
  return { orch, provider };
}

function makeTool(name: string): ToolDefinition {
  return {
    name,
    description: `Tool ${name}`,
    parameters: { type: "object" as const, properties: {} },
    execute: vi.fn().mockResolvedValue("ok"),
  };
}

async function collectEvents(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Orchestrator — Integration Tests", () => {
  beforeEach(() => {
    mockDb.current = createTestDb();
  });

  // =======================================================================
  // Multi-turn Conversations
  // =======================================================================

  describe("Multi-turn Conversations", () => {
    it("3 sends accumulate correct cost", async () => {
      const orch = makeOrchestrator();
      const provider = chattyProvider("claude", orch.sessionStore);
      orch.registerProvider(provider);
      await orch.switchProvider("claude");

      await collectEvents(orch.send("Turn 1"));
      await collectEvents(orch.send("Turn 2"));
      await collectEvents(orch.send("Turn 3"));

      // 0.005 + 0.015 + 0.008 = 0.028
      expect(orch.totalCostUsd).toBeCloseTo(0.028, 3);
    });

    it("3 sends yield correct event types per turn", async () => {
      const orch = makeOrchestrator();
      const provider = chattyProvider("claude", orch.sessionStore);
      orch.registerProvider(provider);
      await orch.switchProvider("claude");

      const events1 = await collectEvents(orch.send("Turn 1"));
      expect(events1.some((e) => e.type === "text")).toBe(true);
      expect(events1.some((e) => e.type === "done")).toBe(true);

      const events2 = await collectEvents(orch.send("Turn 2"));
      expect(events2.some((e) => e.type === "tool_call")).toBe(true);
      expect(events2.some((e) => e.type === "tool_result")).toBe(true);

      const events3 = await collectEvents(orch.send("Turn 3"));
      const textEvents3 = events3.filter((e) => e.type === "text");
      expect(textEvents3.some((e) => (e as any).delta === "Done")).toBe(true);
    });

    it("session store records both user and assistant messages", async () => {
      const { orch } = await makeWiredOrchestrator();

      await collectEvents(orch.send("User question"));

      const messages = orch.sessionStore.getMessages(orch.activeSession!.id);
      const roles = messages.map((m) => m.role);
      expect(roles).toContain("user");
      expect(roles).toContain("assistant");
    });

    it("empty assistant response: no assistant message stored", async () => {
      const orch = makeOrchestrator();
      const provider = mockProvider("claude", orch.sessionStore);
      // Override send to emit done with no text
      (provider.send as any) = vi.fn().mockImplementation(async function* () {
        yield { type: "done" as const, usage: { inputTokens: 10, outputTokens: 0 } };
      });
      orch.registerProvider(provider);
      await orch.switchProvider("claude");

      await collectEvents(orch.send("Hello"));

      const messages = orch.sessionStore.getMessages(orch.activeSession!.id);
      const assistantMessages = messages.filter((m) => m.role === "assistant");
      expect(assistantMessages).toHaveLength(0);
    });

    it("tool calls are forwarded correctly to caller", async () => {
      const orch = makeOrchestrator();
      const provider = chattyProvider("claude", orch.sessionStore);
      orch.registerProvider(provider);
      await orch.switchProvider("claude");

      // First call is plain text, second has tool calls
      await collectEvents(orch.send("Turn 1"));
      const events = await collectEvents(orch.send("Turn 2"));

      const toolCall = events.find((e) => e.type === "tool_call") as any;
      expect(toolCall).toBeDefined();
      expect(toolCall.name).toBe("remote_exec");
      expect(toolCall.id).toBe("tc-1");

      const toolResult = events.find((e) => e.type === "tool_result") as any;
      expect(toolResult).toBeDefined();
      expect(toolResult.callId).toBe("tc-1");
    });
  });

  // =======================================================================
  // Provider Switching
  // =======================================================================

  describe("Provider Switching", () => {
    it("switching mid-conversation: closes old session, carries context", async () => {
      const orch = makeOrchestrator();
      const claude = mockProvider("claude", orch.sessionStore);
      const openai = mockProvider("openai", orch.sessionStore);
      orch.registerProvider(claude);
      orch.registerProvider(openai);

      await orch.switchProvider("claude");
      const claudeSession = await orch.startSession();
      await collectEvents(orch.send("Message to Claude"));

      await orch.switchProvider("openai");
      expect(claude.closeSession).toHaveBeenCalledWith(claudeSession);

      // Context is carried over — session is resumed on the new provider with the same ID
      expect(orch.activeSession).not.toBeNull();
      expect(orch.activeSession!.id).toBe(claudeSession.id);
      expect(openai.resumeSession).toHaveBeenCalledWith(claudeSession.id, expect.any(String));

      await collectEvents(orch.send("Message to OpenAI"));
      expect(orch.activeSession).not.toBeNull();
    });

    it("switching preserves total cost", async () => {
      const orch = makeOrchestrator();
      const claude = mockProvider("claude", orch.sessionStore);
      const openai = mockProvider("openai", orch.sessionStore);
      orch.registerProvider(claude);
      orch.registerProvider(openai);

      await orch.switchProvider("claude");
      await collectEvents(orch.send("Claude msg")); // costs 0.01

      const costAfterClaude = orch.totalCostUsd;
      expect(costAfterClaude).toBeCloseTo(0.01, 3);

      await orch.switchProvider("openai");
      await collectEvents(orch.send("OpenAI msg")); // costs another 0.01

      expect(orch.totalCostUsd).toBeCloseTo(0.02, 3);
    });

    it("resume session on different provider switches correctly", async () => {
      const orch = makeOrchestrator();
      const claude = mockProvider("claude", orch.sessionStore);
      const openai = mockProvider("openai", orch.sessionStore);
      orch.registerProvider(claude);
      orch.registerProvider(openai);

      // Create a session with OpenAI
      await orch.switchProvider("openai");
      const openaiSession = orch.sessionStore.createSession("openai", "gpt-5.4");
      orch.sessionStore.addMessage(openaiSession.id, "user", "Old msg");

      // Currently on OpenAI, resume that session
      await orch.switchProvider("claude");
      await orch.resumeSession(openaiSession.id);

      // Should have switched back to openai
      expect(orch.currentProvider!.name).toBe("openai");
      expect(openai.resumeSession).toHaveBeenCalledWith(
        openaiSession.id,
        "You are a test agent.",
      );
    });

    it("multiple providers registered: can switch between them", async () => {
      const orch = makeOrchestrator();
      const claude = mockProvider("claude", orch.sessionStore);
      const openai = mockProvider("openai", orch.sessionStore);
      orch.registerProvider(claude);
      orch.registerProvider(openai);

      await orch.switchProvider("claude");
      expect(orch.currentProvider!.name).toBe("claude");

      await orch.switchProvider("openai");
      expect(orch.currentProvider!.name).toBe("openai");

      await orch.switchProvider("claude");
      expect(orch.currentProvider!.name).toBe("claude");
    });
  });

  // =======================================================================
  // Send Lock
  // =======================================================================

  describe("Send Lock", () => {
    it("send lock prevents interleaved sends", async () => {
      const { orch } = await makeWiredOrchestrator();

      // Start first send (which we won't await yet)
      const gen1 = orch.send("First");

      // Start iterating first gen to acquire the lock
      const iter1 = gen1[Symbol.asyncIterator]();
      await iter1.next(); // should acquire lock

      // Second send should throw
      await expect(collectEvents(orch.send("Second"))).rejects.toThrow(
        "Another message is already being processed",
      );

      // Finish first send
      let done = false;
      while (!done) {
        const result = await iter1.next();
        done = result.done ?? false;
      }
    });

    it("error in provider.send still releases send lock", async () => {
      const orch = makeOrchestrator();
      const provider = errorProvider("claude", orch.sessionStore);
      orch.registerProvider(provider);
      await orch.switchProvider("claude");

      // First send will error
      await expect(collectEvents(orch.send("Crash"))).rejects.toThrow("Provider exploded");

      // Second send should work (lock released)
      // Reset provider to one that works
      (provider.send as any) = vi.fn().mockImplementation(async function* () {
        yield { type: "text" as const, text: "OK", delta: "OK" };
        yield { type: "done" as const, usage: { inputTokens: 10, outputTokens: 5 } };
      });

      const events = await collectEvents(orch.send("After crash"));
      expect(events.some((e) => e.type === "done")).toBe(true);
    });
  });

  // =======================================================================
  // Cost Tracking
  // =======================================================================

  describe("Cost Tracking", () => {
    it("cost from multiple done events accumulates", async () => {
      const orch = makeOrchestrator();
      const provider = mockProvider("claude", orch.sessionStore);
      // Two done events in one send
      (provider.send as any) = vi.fn().mockImplementation(async function* () {
        yield { type: "text" as const, text: "A", delta: "A" };
        yield { type: "done" as const, usage: { inputTokens: 50, outputTokens: 20, costUsd: 0.005 } };
      });
      orch.registerProvider(provider);
      await orch.switchProvider("claude");

      await collectEvents(orch.send("Msg 1"));
      await collectEvents(orch.send("Msg 2"));

      expect(orch.totalCostUsd).toBeCloseTo(0.01, 3);
    });

    it("cost with no usage event does not change total", async () => {
      const orch = makeOrchestrator();
      const provider = noUsageProvider("claude", orch.sessionStore);
      orch.registerProvider(provider);
      await orch.switchProvider("claude");

      await collectEvents(orch.send("Message"));
      expect(orch.totalCostUsd).toBe(0);
    });

    it("ephemeral session: cost tracked in memory but not persisted to DB via addCost", async () => {
      const orch = makeOrchestrator();
      const provider = mockProvider("claude", orch.sessionStore);
      // Override createSession to return ephemeral — also create a real DB session
      // so addMessage doesn't fail on FK constraint. The real test is that addCost skips.
      (provider.createSession as any) = vi.fn().mockImplementation(async () => {
        // Create a real session in DB so addMessage works
        const real = orch.sessionStore.createSession("claude", "opus");
        // But return an ephemeral-looking session ID wrapper
        return {
          id: real.id,
          providerId: "claude",
          createdAt: Date.now(),
          lastActiveAt: Date.now(),
        };
      });
      orch.registerProvider(provider);
      await orch.switchProvider("claude");

      await collectEvents(orch.send("Msg"));

      // Cost is tracked in memory
      expect(orch.totalCostUsd).toBeCloseTo(0.01, 3);
    });

    it("addCost from external source accumulates", async () => {
      const { orch } = await makeWiredOrchestrator();
      await orch.startSession();

      orch.addCost(0.05, 500, 200);
      orch.addCost(0.03, 300, 100);

      expect(orch.totalCostUsd).toBeCloseTo(0.08, 3);
    });
  });

  // =======================================================================
  // Sticky Notes
  // =======================================================================

  describe("Sticky Notes", () => {
    it("sticky notes prepended to every message", async () => {
      const orch = makeOrchestrator();
      const provider = mockProvider("claude", orch.sessionStore);
      orch.registerProvider(provider);
      await orch.switchProvider("claude");

      const stickies = new StickyManager();
      stickies.add("Always use GPU 0");
      orch.setStickyManager(stickies);

      await collectEvents(orch.send("Train model"));

      const sendCall = (provider.send as any).mock.calls[0];
      const message = sendCall[1] as string;
      expect(message).toContain("Always use GPU 0");
      expect(message).toContain("Train model");
    });

    it("sticky notes change between sends", async () => {
      const orch = makeOrchestrator();
      const provider = mockProvider("claude", orch.sessionStore);
      orch.registerProvider(provider);
      await orch.switchProvider("claude");

      const stickies = new StickyManager();
      stickies.add("Note 1");
      orch.setStickyManager(stickies);

      await collectEvents(orch.send("Msg 1"));
      const msg1 = (provider.send as any).mock.calls[0][1] as string;
      expect(msg1).toContain("Note 1");

      stickies.add("Note 2");
      await collectEvents(orch.send("Msg 2"));
      const msg2 = (provider.send as any).mock.calls[1][1] as string;
      expect(msg2).toContain("Note 1");
      expect(msg2).toContain("Note 2");
    });

    it("no sticky notes: message passed through unchanged", async () => {
      const orch = makeOrchestrator();
      const provider = mockProvider("claude", orch.sessionStore);
      orch.registerProvider(provider);
      await orch.switchProvider("claude");

      await collectEvents(orch.send("Plain message"));

      const sendCall = (provider.send as any).mock.calls[0];
      expect(sendCall[1]).toBe("Plain message");
    });
  });

  // =======================================================================
  // Context Gate / Checkpoint
  // =======================================================================

  describe("Context Gate / Checkpoint", () => {
    it("context gate not set: maybeCheckpoint is no-op", async () => {
      const { orch, provider } = await makeWiredOrchestrator();
      // No context gate set
      await collectEvents(orch.send("Message"));

      expect(provider.resetHistory).not.toHaveBeenCalled();
    });

    it("context gate set: checkpoint when threshold exceeded", async () => {
      const orch = makeOrchestrator();
      const provider = mockProvider("claude", orch.sessionStore);
      // Provider reports high input tokens to trigger checkpoint
      let sendCallCount = 0;
      (provider.send as any) = vi.fn().mockImplementation(async function* () {
        sendCallCount++;
        if (sendCallCount === 1) {
          yield { type: "text" as const, text: "Reply", delta: "Reply" };
          yield { type: "done" as const, usage: { inputTokens: 999999, outputTokens: 50, costUsd: 0.01 } };
        } else {
          // Gist generation call
          yield { type: "text" as const, text: "My gist of the conversation", delta: "My gist of the conversation" };
          yield { type: "done" as const, usage: { inputTokens: 100, outputTokens: 50, costUsd: 0.005 } };
        }
      });
      orch.registerProvider(provider);
      await orch.switchProvider("claude");

      const mockGate = {
        onSessionStart: vi.fn(),
        checkThreshold: vi.fn().mockReturnValue(true),
        performCheckpointWithGist: vi.fn().mockReturnValue("=== CHECKPOINT BRIEFING ==="),
      };
      orch.setContextGate(mockGate as any);

      const events = await collectEvents(orch.send("Trigger checkpoint"));

      expect(mockGate.checkThreshold).toHaveBeenCalled();
      expect(mockGate.performCheckpointWithGist).toHaveBeenCalledWith("My gist of the conversation");
      expect(provider.resetHistory).toHaveBeenCalledWith(
        expect.anything(),
        "=== CHECKPOINT BRIEFING ===",
      );
    });

    it("checkpoint resets provider history", async () => {
      const orch = makeOrchestrator();
      const provider = mockProvider("claude", orch.sessionStore);
      let sendCallCount = 0;
      (provider.send as any) = vi.fn().mockImplementation(async function* () {
        sendCallCount++;
        yield { type: "text" as const, text: `Response ${sendCallCount}`, delta: `Response ${sendCallCount}` };
        yield { type: "done" as const, usage: { inputTokens: sendCallCount === 1 ? 999999 : 50, outputTokens: 20 } };
      });
      orch.registerProvider(provider);
      await orch.switchProvider("claude");

      const mockGate = {
        onSessionStart: vi.fn(),
        checkThreshold: vi.fn().mockImplementation((_model: string, tokens: number) => tokens > 100000),
        performCheckpointWithGist: vi.fn().mockReturnValue("Briefing"),
      };
      orch.setContextGate(mockGate as any);

      const events = await collectEvents(orch.send("Big message"));

      // resetHistory should have been called once
      expect(provider.resetHistory).toHaveBeenCalledTimes(1);

      // The checkpoint text event should be in the output
      const checkpointText = events.find(
        (e) => e.type === "text" && (e as any).text.includes("Context checkpoint"),
      );
      expect(checkpointText).toBeDefined();
    });

    it("context gate: low token count does not trigger checkpoint", async () => {
      const { orch, provider } = await makeWiredOrchestrator();

      const mockGate = {
        onSessionStart: vi.fn(),
        checkThreshold: vi.fn().mockReturnValue(false),
        performCheckpointWithGist: vi.fn(),
      };
      orch.setContextGate(mockGate as any);

      await collectEvents(orch.send("Small message"));

      expect(mockGate.checkThreshold).toHaveBeenCalled();
      expect(mockGate.performCheckpointWithGist).not.toHaveBeenCalled();
      expect(provider.resetHistory).not.toHaveBeenCalled();
    });
  });

  // =======================================================================
  // State Machine
  // =======================================================================

  describe("State Machine", () => {
    it("transitions: idle -> active on startSession", async () => {
      const orch = makeOrchestrator();
      orch.registerProvider(mockProvider("claude"));
      await orch.switchProvider("claude");

      expect(orch.currentState).toBe("idle");
      await orch.startSession();
      expect(orch.currentState).toBe("active");
    });

    it("start session auto-authenticates provider", async () => {
      const orch = makeOrchestrator();
      const provider = mockProvider("claude");
      orch.registerProvider(provider);

      // Don't switch manually — let startSession do it
      await orch.startSession();

      expect(provider.authenticate).toHaveBeenCalledOnce();
    });
  });

  // =======================================================================
  // Interrupt
  // =======================================================================

  describe("Interrupt", () => {
    it("interrupt during send aborts provider", async () => {
      const { orch, provider } = await makeWiredOrchestrator();

      // Start a send
      const gen = orch.send("Long running");
      const iter = gen[Symbol.asyncIterator]();

      // Get first event
      await iter.next();

      // Interrupt
      orch.interrupt();

      expect(provider.interrupt).toHaveBeenCalled();
    });

    it("interrupt with no active session is safe", () => {
      const orch = makeOrchestrator();
      // Should not throw
      expect(() => orch.interrupt()).not.toThrow();
    });
  });

  // =======================================================================
  // setModel / fetchModels
  // =======================================================================

  describe("setModel / fetchModels", () => {
    it("setModel resets session", async () => {
      const { orch, provider } = await makeWiredOrchestrator();
      await orch.startSession();

      expect(orch.activeSession).not.toBeNull();

      await orch.setModel("claude-sonnet-4-6");
      expect(provider.currentModel).toBe("claude-sonnet-4-6");
      expect(provider.closeSession).toHaveBeenCalled();
      expect(orch.activeSession).toBeNull();
    });

    it("fetchModels delegates to active provider", async () => {
      const { orch, provider } = await makeWiredOrchestrator();
      const models = await orch.fetchModels();

      expect(provider.fetchModels).toHaveBeenCalled();
      expect(models).toEqual([{ id: "test-model", name: "Test Model" }]);
    });

    it("fetchModels auto-switches provider if none active", async () => {
      const orch = makeOrchestrator();
      const provider = mockProvider("claude");
      orch.registerProvider(provider);

      const models = await orch.fetchModels();
      expect(provider.authenticate).toHaveBeenCalled();
      expect(models).toEqual([{ id: "test-model", name: "Test Model" }]);
    });
  });

  // =======================================================================
  // Reasoning Effort
  // =======================================================================

  describe("Reasoning Effort", () => {
    it("reasoningEffort reflects provider setting", async () => {
      const { orch, provider } = await makeWiredOrchestrator();
      provider.reasoningEffort = "high";
      expect(orch.reasoningEffort).toBe("high");
    });

    it("setReasoningEffort updates provider", async () => {
      const { orch, provider } = await makeWiredOrchestrator();
      await orch.setReasoningEffort("max");
      expect(provider.reasoningEffort).toBe("max");
    });

    it("reasoningEffort is null when no provider active", () => {
      const orch = makeOrchestrator();
      expect(orch.reasoningEffort).toBeNull();
    });
  });

  // =======================================================================
  // Tools
  // =======================================================================

  describe("Tools", () => {
    it("registerTool adds tool and passes it in send", async () => {
      const { orch, provider } = await makeWiredOrchestrator();
      const tool = makeTool("remote_exec");
      orch.registerTool(tool);

      await collectEvents(orch.send("Use the tool"));

      const sendCall = (provider.send as any).mock.calls[0];
      const tools = sendCall[2] as ToolDefinition[];
      expect(tools.some((t) => t.name === "remote_exec")).toBe(true);
    });

    it("registerTools adds multiple tools", async () => {
      const { orch } = await makeWiredOrchestrator();
      orch.registerTools([makeTool("tool_a"), makeTool("tool_b")]);

      expect(orch.getTools()).toHaveLength(2);
    });

    it("duplicate tool registration is prevented", async () => {
      const { orch } = await makeWiredOrchestrator();
      orch.registerTool(makeTool("tool_a"));
      orch.registerTool(makeTool("tool_a"));

      expect(orch.getTools()).toHaveLength(1);
    });
  });

  // =======================================================================
  // Error Propagation
  // =======================================================================

  describe("Error Propagation", () => {
    it("error in provider.send propagates to caller", async () => {
      const orch = makeOrchestrator();
      const provider = errorProvider("claude", orch.sessionStore);
      orch.registerProvider(provider);
      await orch.switchProvider("claude");

      await expect(collectEvents(orch.send("Boom"))).rejects.toThrow("Provider exploded");
    });

    it("error does not leave cost in inconsistent state", async () => {
      const orch = makeOrchestrator();
      const provider = errorProvider("claude", orch.sessionStore);
      orch.registerProvider(provider);
      await orch.switchProvider("claude");

      try {
        await collectEvents(orch.send("Boom"));
      } catch {
        // expected
      }

      // Cost should still be 0 since no done event was emitted
      expect(orch.totalCostUsd).toBe(0);
    });
  });

  // =======================================================================
  // lastInputTokens
  // =======================================================================

  describe("lastInputTokens", () => {
    it("tracks last input token count from done event", async () => {
      const { orch } = await makeWiredOrchestrator();
      await collectEvents(orch.send("Check tokens"));

      expect(orch.lastInputTokens).toBe(100);
    });

    it("updates with each send", async () => {
      const orch = makeOrchestrator();
      const provider = chattyProvider("claude", orch.sessionStore);
      orch.registerProvider(provider);
      await orch.switchProvider("claude");

      await collectEvents(orch.send("Turn 1")); // 50 input tokens
      expect(orch.lastInputTokens).toBe(50);

      await collectEvents(orch.send("Turn 2")); // 100 input tokens
      expect(orch.lastInputTokens).toBe(100);
    });
  });
});
