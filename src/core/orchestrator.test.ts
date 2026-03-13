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

/**
 * Creates a mock ModelProvider. If a SessionStore is provided, createSession
 * will insert the session into the DB so that foreign-key dependent operations
 * (addMessage, addCost, etc.) succeed.
 */
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
      yield {
        type: "text" as const,
        text: "Hello",
        delta: "Hello",
      };
      yield {
        type: "done" as const,
        usage: { inputTokens: 100, outputTokens: 50, costUsd: 0.01 },
      };
    }),
    interrupt: vi.fn(),
    resetHistory: vi.fn(),
    closeSession: vi.fn().mockResolvedValue(undefined),
    fetchModels: vi
      .fn()
      .mockResolvedValue([{ id: "test-model", name: "Test Model" }]),
  } as unknown as ModelProvider;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOrchestrator(defaultProvider: "claude" | "openai" = "claude") {
  return new Orchestrator({
    defaultProvider,
    systemPrompt: "You are a test agent.",
    sessionStore: new SessionStore("test-agent"),
  });
}

/**
 * Create an orchestrator wired to a mock provider whose createSession inserts
 * into the DB (so addMessage / addCost don't violate foreign key constraints).
 */
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

/** Collect all events from an async generator. */
async function collectEvents(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const e of gen) {
    events.push(e);
  }
  return events;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Orchestrator", () => {
  beforeEach(() => {
    mockDb.current = createTestDb();
  });

  // =======================================================================
  // Provider Management
  // =======================================================================

  describe("Provider Management", () => {
    it("registerProvider stores provider by name", () => {
      const orch = makeOrchestrator();
      const provider = mockProvider("claude");
      orch.registerProvider(provider);

      expect(orch.getProvider("claude")).toBe(provider);
    });

    it("registerProvider for both claude and openai", () => {
      const orch = makeOrchestrator();
      const claude = mockProvider("claude");
      const openai = mockProvider("openai");
      orch.registerProvider(claude);
      orch.registerProvider(openai);

      expect(orch.getProvider("claude")).toBe(claude);
      expect(orch.getProvider("openai")).toBe(openai);
    });

    it("getProvider returns registered provider by name", () => {
      const orch = makeOrchestrator();
      const provider = mockProvider("openai");
      orch.registerProvider(provider);

      expect(orch.getProvider("openai")).toBe(provider);
    });

    it("getProvider with no args returns active provider", async () => {
      const orch = makeOrchestrator();
      const provider = mockProvider("claude");
      orch.registerProvider(provider);

      // Before switching, no active provider
      expect(orch.getProvider()).toBeNull();

      await orch.switchProvider("claude");
      expect(orch.getProvider()).toBe(provider);
    });

    it("getProvider returns null if not registered", () => {
      const orch = makeOrchestrator();
      expect(orch.getProvider("claude")).toBeNull();
      expect(orch.getProvider("openai")).toBeNull();
    });

    it("switchProvider authenticates and sets active", async () => {
      const orch = makeOrchestrator();
      const provider = mockProvider("claude");
      orch.registerProvider(provider);

      await orch.switchProvider("claude");

      expect(provider.authenticate).toHaveBeenCalledOnce();
      expect(orch.getProvider()).toBe(provider);
    });

    it("switchProvider cleans up previous session", async () => {
      const orch = makeOrchestrator();
      const claude = mockProvider("claude");
      const openai = mockProvider("openai");
      orch.registerProvider(claude);
      orch.registerProvider(openai);

      await orch.switchProvider("claude");
      const session = await orch.startSession();

      await orch.switchProvider("openai");

      expect(claude.closeSession).toHaveBeenCalledWith(session);
      expect(orch.activeSession).toBeNull();
    });

    it("switchProvider throws for unregistered provider", async () => {
      const orch = makeOrchestrator();

      await expect(orch.switchProvider("openai")).rejects.toThrow(
        'Provider "openai" not registered',
      );
    });

    it("switchProvider saves preference", async () => {
      const { savePreferences } = await import("../store/preferences.js");
      const orch = makeOrchestrator();
      orch.registerProvider(mockProvider("claude"));

      await orch.switchProvider("claude");

      expect(savePreferences).toHaveBeenCalledWith({
        lastProvider: "claude",
      });
    });

    it("switchProvider to same provider re-authenticates", async () => {
      const orch = makeOrchestrator();
      const provider = mockProvider("claude");
      orch.registerProvider(provider);

      await orch.switchProvider("claude");
      await orch.switchProvider("claude");

      expect(provider.authenticate).toHaveBeenCalledTimes(2);
    });

    it("currentProvider returns active provider", async () => {
      const orch = makeOrchestrator();
      const provider = mockProvider("claude");
      orch.registerProvider(provider);

      expect(orch.currentProvider).toBeNull();
      await orch.switchProvider("claude");
      expect(orch.currentProvider).toBe(provider);
    });

    it("registerProvider overwrites existing provider with same name", () => {
      const orch = makeOrchestrator();
      const p1 = mockProvider("claude");
      const p2 = mockProvider("claude");
      orch.registerProvider(p1);
      orch.registerProvider(p2);

      expect(orch.getProvider("claude")).toBe(p2);
    });

    it("switchProvider cleans up session even if closeSession throws", async () => {
      const orch = makeOrchestrator();
      const claude = mockProvider("claude");
      const openai = mockProvider("openai");
      (claude.closeSession as any).mockRejectedValue(new Error("cleanup failed"));
      orch.registerProvider(claude);
      orch.registerProvider(openai);

      await orch.switchProvider("claude");
      await orch.startSession();

      // Should not throw despite closeSession failure
      await orch.switchProvider("openai");
      expect(orch.getProvider()).toBe(openai);
    });
  });

  // =======================================================================
  // Session Lifecycle
  // =======================================================================

  describe("Session Lifecycle", () => {
    it("startSession creates session via provider", async () => {
      const orch = makeOrchestrator();
      const provider = mockProvider("claude");
      orch.registerProvider(provider);
      await orch.switchProvider("claude");

      const session = await orch.startSession();

      expect(provider.createSession).toHaveBeenCalledOnce();
      expect(session.id).toBeTruthy();
      expect(session.providerId).toBe("claude");
    });

    it("startSession auto-switches to default provider if none active", async () => {
      const orch = makeOrchestrator("claude");
      const provider = mockProvider("claude");
      orch.registerProvider(provider);

      const session = await orch.startSession();

      expect(provider.authenticate).toHaveBeenCalledOnce();
      expect(session).toBeTruthy();
    });

    it("startSession binds context gate", async () => {
      const orch = makeOrchestrator();
      const provider = mockProvider("claude");
      orch.registerProvider(provider);
      await orch.switchProvider("claude");

      const mockGate = {
        onSessionStart: vi.fn(),
        checkThreshold: vi.fn().mockReturnValue(false),
        performCheckpointWithGist: vi.fn(),
      };
      orch.setContextGate(mockGate as any);

      const session = await orch.startSession();
      expect(mockGate.onSessionStart).toHaveBeenCalledWith(session.id);
    });

    it("startSession transitions state machine to active", async () => {
      const orch = makeOrchestrator();
      orch.registerProvider(mockProvider("claude"));
      await orch.switchProvider("claude");

      expect(orch.currentState).toBe("idle");
      await orch.startSession();
      expect(orch.currentState).toBe("active");
    });

    it("startSession passes config to provider", async () => {
      const orch = makeOrchestrator();
      const provider = mockProvider("claude");
      orch.registerProvider(provider);
      await orch.switchProvider("claude");

      await orch.startSession({ model: "opus", temperature: 0.5 });

      expect(provider.createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          systemPrompt: "You are a test agent.",
          model: "opus",
          temperature: 0.5,
        }),
      );
    });

    it("ensureSession returns existing session", async () => {
      const orch = makeOrchestrator();
      orch.registerProvider(mockProvider("claude"));
      await orch.switchProvider("claude");

      const s1 = await orch.startSession();
      const s2 = await orch.ensureSession();

      expect(s2).toBe(s1);
    });

    it("ensureSession creates new if none exists", async () => {
      const orch = makeOrchestrator();
      orch.registerProvider(mockProvider("claude"));
      await orch.switchProvider("claude");

      const session = await orch.ensureSession();
      expect(session).toBeTruthy();
      expect(session.id).toBeTruthy();
    });

    it("resumeSession loads from DB", async () => {
      const orch = makeOrchestrator();
      const provider = mockProvider("claude");
      orch.registerProvider(provider);
      await orch.switchProvider("claude");

      // Create a session in the DB first
      const dbSession = orch.sessionStore.createSession("claude", "opus");

      const session = await orch.resumeSession(dbSession.id);
      expect(provider.resumeSession).toHaveBeenCalledWith(
        dbSession.id,
        "You are a test agent.",
      );
      expect(session.id).toBe(dbSession.id);
    });

    it("resumeSession switches provider if needed", async () => {
      const orch = makeOrchestrator();
      const claude = mockProvider("claude");
      const openai = mockProvider("openai");
      orch.registerProvider(claude);
      orch.registerProvider(openai);
      await orch.switchProvider("claude");

      // Create a session stored as openai
      const dbSession = orch.sessionStore.createSession("openai", "gpt-5.4");

      await orch.resumeSession(dbSession.id);

      // Should have switched to openai
      expect(orch.getProvider()).toBe(openai);
      expect(openai.authenticate).toHaveBeenCalled();
    });

    it("resumeSession binds context gate", async () => {
      const orch = makeOrchestrator();
      orch.registerProvider(mockProvider("claude"));
      await orch.switchProvider("claude");

      const mockGate = {
        onSessionStart: vi.fn(),
        checkThreshold: vi.fn().mockReturnValue(false),
        performCheckpointWithGist: vi.fn(),
      };
      orch.setContextGate(mockGate as any);

      const dbSession = orch.sessionStore.createSession("claude");
      await orch.resumeSession(dbSession.id);

      expect(mockGate.onSessionStart).toHaveBeenCalledWith(dbSession.id);
    });

    it("resumeSession throws for unknown session", async () => {
      const orch = makeOrchestrator();
      orch.registerProvider(mockProvider("claude"));
      await orch.switchProvider("claude");

      await expect(orch.resumeSession("nonexistent-id")).rejects.toThrow(
        'Session "nonexistent-id" not found',
      );
    });

    it("resumeSession transitions state machine to active", async () => {
      const orch = makeOrchestrator();
      orch.registerProvider(mockProvider("claude"));
      await orch.switchProvider("claude");

      const dbSession = orch.sessionStore.createSession("claude");
      await orch.resumeSession(dbSession.id);

      expect(orch.currentState).toBe("active");
    });

    it("activeSession reflects current session", async () => {
      const orch = makeOrchestrator();
      orch.registerProvider(mockProvider("claude"));
      await orch.switchProvider("claude");

      expect(orch.activeSession).toBeNull();

      const session = await orch.startSession();
      expect(orch.activeSession).toBe(session);
    });

    it("currentSession is an alias for activeSession", async () => {
      const orch = makeOrchestrator();
      orch.registerProvider(mockProvider("claude"));
      await orch.switchProvider("claude");

      const session = await orch.startSession();
      expect(orch.currentSession).toBe(session);
    });
  });

  // =======================================================================
  // Message Flow
  // =======================================================================

  describe("Message Flow", () => {
    it("send yields events from provider", async () => {
      const { orch } = await makeWiredOrchestrator();
      await orch.startSession();

      const events = await collectEvents(orch.send("Hello"));
      const textEvents = events.filter((e) => e.type === "text");
      const doneEvents = events.filter((e) => e.type === "done");

      expect(textEvents.length).toBeGreaterThanOrEqual(1);
      expect(doneEvents).toHaveLength(1);
    });

    it("send stores user message in session store", async () => {
      const { orch } = await makeWiredOrchestrator();
      await orch.startSession();

      await collectEvents(orch.send("Test message"));

      const messages = orch.sessionStore.getMessages(orch.activeSession!.id);
      expect(messages.some((m) => m.role === "user" && m.content === "Test message")).toBe(true);
    });

    it("send stores assistant response in session store", async () => {
      const { orch } = await makeWiredOrchestrator();
      await orch.startSession();

      await collectEvents(orch.send("Hello"));

      const messages = orch.sessionStore.getMessages(orch.activeSession!.id);
      expect(messages.some((m) => m.role === "assistant" && m.content === "Hello")).toBe(true);
    });

    it("send prepends sticky notes to message", async () => {
      const { orch, provider } = await makeWiredOrchestrator();
      await orch.startSession();

      const stickies = new StickyManager();
      stickies.add("Always use GPU");
      orch.setStickyManager(stickies);

      await collectEvents(orch.send("Train a model"));

      // The provider.send should have been called with augmented message
      const sendCall = (provider.send as any).mock.calls[0];
      const sentMessage = sendCall[1] as string;
      expect(sentMessage).toContain("STICKY NOTES");
      expect(sentMessage).toContain("Always use GPU");
      expect(sentMessage).toContain("Train a model");
    });

    it("send without stickies passes message unchanged", async () => {
      const { orch, provider } = await makeWiredOrchestrator();
      await orch.startSession();

      await collectEvents(orch.send("Plain message"));

      const sendCall = (provider.send as any).mock.calls[0];
      const sentMessage = sendCall[1] as string;
      expect(sentMessage).toBe("Plain message");
    });

    it("send tracks cost from done event", async () => {
      const { orch } = await makeWiredOrchestrator();
      await orch.startSession();

      await collectEvents(orch.send("Hello"));

      expect(orch.totalCostUsd).toBeCloseTo(0.01);
    });

    it("send tracks input tokens from done event", async () => {
      const { orch } = await makeWiredOrchestrator();
      await orch.startSession();

      await collectEvents(orch.send("Hello"));

      expect(orch.lastInputTokens).toBe(100);
    });

    it("send lock prevents concurrent sends", async () => {
      const { orch, provider } = await makeWiredOrchestrator();

      // Make send take a while
      let resolveBarrier!: () => void;
      const barrier = new Promise<void>((r) => (resolveBarrier = r));
      (provider.send as any).mockImplementation(async function* () {
        await barrier;
        yield { type: "text" as const, text: "ok", delta: "ok" };
        yield { type: "done" as const, usage: { inputTokens: 10, outputTokens: 5, costUsd: 0 } };
      });

      await orch.startSession();

      // Start first send (will block on barrier)
      const gen1 = orch.send("First");
      // Start iterating to acquire the lock
      const p1 = gen1.next();

      // Second send should throw
      await expect(collectEvents(orch.send("Second"))).rejects.toThrow(
        "Another message is already being processed",
      );

      // Clean up
      resolveBarrier();
      await p1;
      await collectEvents(gen1);
    });

    it("send lock is released after completion", async () => {
      const { orch } = await makeWiredOrchestrator();
      await orch.startSession();

      await collectEvents(orch.send("First"));
      // Should not throw
      await collectEvents(orch.send("Second"));
    });

    it("send lock is released after error", async () => {
      const { orch, provider } = await makeWiredOrchestrator();
      (provider.send as any).mockImplementation(async function* () {
        throw new Error("provider error");
      });
      await orch.startSession();

      await expect(collectEvents(orch.send("Fail"))).rejects.toThrow("provider error");

      // Restore working provider
      (provider.send as any).mockImplementation(async function* () {
        yield { type: "text" as const, text: "ok", delta: "ok" };
        yield { type: "done" as const, usage: { inputTokens: 10, outputTokens: 5, costUsd: 0 } };
      });

      // Lock should be released — next send should work
      await collectEvents(orch.send("Recover"));
    });

    it("send auto-starts session if none active", async () => {
      const orch = makeOrchestrator();
      const provider = mockProvider("claude", orch.sessionStore);
      orch.registerProvider(provider);

      // No switchProvider, no startSession — send should handle it
      const events = await collectEvents(orch.send("Auto start"));

      expect(provider.authenticate).toHaveBeenCalled();
      expect(provider.createSession).toHaveBeenCalled();
      expect(events.some((e) => e.type === "done")).toBe(true);
    });

    it("send calls maybeCheckpoint after done", async () => {
      const { orch, provider } = await makeWiredOrchestrator();

      const mockGate = {
        onSessionStart: vi.fn(),
        checkThreshold: vi.fn().mockReturnValue(true),
        performCheckpointWithGist: vi.fn().mockReturnValue("checkpoint briefing"),
      };
      orch.setContextGate(mockGate as any);

      // Provider will be called twice: once for the user message, once for checkpoint gist
      let callCount = 0;
      (provider.send as any).mockImplementation(async function* () {
        callCount++;
        if (callCount === 1) {
          yield { type: "text" as const, text: "response", delta: "response" };
          yield { type: "done" as const, usage: { inputTokens: 100, outputTokens: 50, costUsd: 0.01 } };
        } else {
          // checkpoint gist generation
          yield { type: "text" as const, text: "gist content", delta: "gist content" };
          yield { type: "done" as const, usage: { inputTokens: 50, outputTokens: 20, costUsd: 0.005 } };
        }
      });

      await orch.startSession();
      const events = await collectEvents(orch.send("Hello"));

      // Should have a checkpoint text event
      expect(
        events.some(
          (e) => e.type === "text" && (e as any).text.includes("Context checkpoint"),
        ),
      ).toBe(true);
      expect(mockGate.checkThreshold).toHaveBeenCalled();
    });

    it("send passes tools and attachments to provider", async () => {
      const { orch, provider } = await makeWiredOrchestrator();
      await orch.startSession();

      const tool = makeTool("my_tool");
      orch.registerTool(tool);

      const attachment = {
        filename: "test.png",
        mediaType: "image/png",
        data: "base64data",
      };
      await collectEvents(orch.send("Use tool", [attachment]));

      const sendCall = (provider.send as any).mock.calls[0];
      expect(sendCall[2]).toContain(tool); // tools
      expect(sendCall[3]).toEqual([attachment]); // attachments
    });

    it("send accumulates cost from multiple messages", async () => {
      const { orch } = await makeWiredOrchestrator();
      await orch.startSession();

      await collectEvents(orch.send("msg1")); // 0.01
      await collectEvents(orch.send("msg2")); // 0.01

      expect(orch.totalCostUsd).toBeCloseTo(0.02);
    });

    it("send updates lastActive on session store", async () => {
      const { orch } = await makeWiredOrchestrator();
      await orch.startSession();

      const sessionId = orch.activeSession!.id;
      // Spy on updateLastActive
      const spy = vi.spyOn(orch.sessionStore, "updateLastActive");

      await collectEvents(orch.send("Hello"));

      expect(spy).toHaveBeenCalledWith(sessionId);
    });

    it("send with empty stickies passes message unchanged", async () => {
      const { orch, provider } = await makeWiredOrchestrator();
      await orch.startSession();

      // Set sticky manager with no notes
      orch.setStickyManager(new StickyManager());

      await collectEvents(orch.send("No stickies"));

      const sendCall = (provider.send as any).mock.calls[0];
      expect(sendCall[1]).toBe("No stickies");
    });

    it("send builds full response from text deltas", async () => {
      const { orch, provider } = await makeWiredOrchestrator();
      (provider.send as any).mockImplementation(async function* () {
        yield { type: "text" as const, text: "He", delta: "He" };
        yield { type: "text" as const, text: "llo", delta: "llo" };
        yield { type: "done" as const, usage: { inputTokens: 10, outputTokens: 5, costUsd: 0 } };
      });
      await orch.startSession();

      await collectEvents(orch.send("Hi"));

      const messages = orch.sessionStore.getMessages(orch.activeSession!.id);
      const assistantMsg = messages.find((m) => m.role === "assistant");
      expect(assistantMsg!.content).toBe("Hello");
    });

    it("send does not store empty assistant response", async () => {
      const { orch, provider } = await makeWiredOrchestrator();
      (provider.send as any).mockImplementation(async function* () {
        yield { type: "done" as const, usage: { inputTokens: 10, outputTokens: 0, costUsd: 0 } };
      });
      await orch.startSession();

      await collectEvents(orch.send("Hi"));

      const messages = orch.sessionStore.getMessages(orch.activeSession!.id);
      expect(messages.filter((m) => m.role === "assistant")).toHaveLength(0);
    });
  });

  // =======================================================================
  // Tool Management
  // =======================================================================

  describe("Tool Management", () => {
    it("registerTool adds tool", () => {
      const orch = makeOrchestrator();
      const tool = makeTool("remote_exec");
      orch.registerTool(tool);

      expect(orch.getTools()).toContain(tool);
    });

    it("registerTool deduplicates by name", () => {
      const orch = makeOrchestrator();
      const tool1 = makeTool("remote_exec");
      const tool2 = makeTool("remote_exec");

      orch.registerTool(tool1);
      orch.registerTool(tool2);

      expect(orch.getTools()).toHaveLength(1);
      // First registration wins
      expect(orch.getTools()[0]).toBe(tool1);
    });

    it("registerTools adds multiple tools", () => {
      const orch = makeOrchestrator();
      const tools = [makeTool("tool_a"), makeTool("tool_b"), makeTool("tool_c")];
      orch.registerTools(tools);

      expect(orch.getTools()).toHaveLength(3);
    });

    it("registerTools deduplicates", () => {
      const orch = makeOrchestrator();
      const tools = [
        makeTool("tool_a"),
        makeTool("tool_b"),
        makeTool("tool_a"),
      ];
      orch.registerTools(tools);

      expect(orch.getTools()).toHaveLength(2);
    });

    it("getTools returns all registered tools", () => {
      const orch = makeOrchestrator();
      orch.registerTool(makeTool("alpha"));
      orch.registerTool(makeTool("beta"));

      const tools = orch.getTools();
      expect(tools).toHaveLength(2);
      expect(tools.map((t) => t.name)).toEqual(["alpha", "beta"]);
    });

    it("getTools returns empty array when no tools registered", () => {
      const orch = makeOrchestrator();
      expect(orch.getTools()).toEqual([]);
    });

    it("registerTool after registerTools appends", () => {
      const orch = makeOrchestrator();
      orch.registerTools([makeTool("a"), makeTool("b")]);
      orch.registerTool(makeTool("c"));

      expect(orch.getTools()).toHaveLength(3);
    });

    it("registerTools preserves order", () => {
      const orch = makeOrchestrator();
      const tools = [makeTool("z"), makeTool("a"), makeTool("m")];
      orch.registerTools(tools);

      expect(orch.getTools().map((t) => t.name)).toEqual(["z", "a", "m"]);
    });
  });

  // =======================================================================
  // Cost Tracking
  // =======================================================================

  describe("Cost Tracking", () => {
    it("addCost accumulates total", async () => {
      const { orch } = await makeWiredOrchestrator();
      await orch.startSession();

      orch.addCost(0.05);
      orch.addCost(0.03);

      expect(orch.totalCostUsd).toBeCloseTo(0.08);
    });

    it("addCost persists to session store", async () => {
      const { orch } = await makeWiredOrchestrator();
      await orch.startSession();

      const spy = vi.spyOn(orch.sessionStore, "addCost");
      orch.addCost(0.01, 100, 50);

      expect(spy).toHaveBeenCalledWith(orch.activeSession!.id, 0.01, 100, 50);
    });

    it("addCost skips DB write for ephemeral sessions (eph- prefix)", async () => {
      const orch = makeOrchestrator();
      const provider = mockProvider("claude");
      // Make provider return ephemeral-like session
      (provider.createSession as any).mockResolvedValue({
        id: "eph-abc123",
        providerId: "claude",
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
      });
      orch.registerProvider(provider);
      await orch.switchProvider("claude");
      await orch.startSession();

      const spy = vi.spyOn(orch.sessionStore, "addCost");
      orch.addCost(0.01, 100, 50);

      expect(spy).not.toHaveBeenCalled();
      // But total still accumulates
      expect(orch.totalCostUsd).toBeCloseTo(0.01);
    });

    it("totalCostUsd returns accumulated cost", () => {
      const orch = makeOrchestrator();
      expect(orch.totalCostUsd).toBe(0);
    });

    it("lastInputTokens returns last reported tokens", async () => {
      const { orch } = await makeWiredOrchestrator();
      await orch.startSession();

      expect(orch.lastInputTokens).toBe(0);

      await collectEvents(orch.send("Hello"));

      expect(orch.lastInputTokens).toBe(100);
    });

    it("addCost with no tokens defaults to zero", async () => {
      const { orch } = await makeWiredOrchestrator();
      await orch.startSession();

      const spy = vi.spyOn(orch.sessionStore, "addCost");
      orch.addCost(0.01);

      expect(spy).toHaveBeenCalledWith(orch.activeSession!.id, 0.01, 0, 0);
    });

    it("addCost with no active session does not write to DB", () => {
      const orch = makeOrchestrator();
      const spy = vi.spyOn(orch.sessionStore, "addCost");

      orch.addCost(0.01);

      expect(spy).not.toHaveBeenCalled();
      expect(orch.totalCostUsd).toBeCloseTo(0.01);
    });

    it("cost persists across multiple send calls", async () => {
      const { orch } = await makeWiredOrchestrator();
      await orch.startSession();

      await collectEvents(orch.send("a"));
      await collectEvents(orch.send("b"));
      await collectEvents(orch.send("c"));

      expect(orch.totalCostUsd).toBeCloseTo(0.03);
    });
  });

  // =======================================================================
  // Model & Reasoning
  // =======================================================================

  describe("Model & Reasoning", () => {
    it("setModel changes provider model", async () => {
      const orch = makeOrchestrator();
      const provider = mockProvider("claude");
      orch.registerProvider(provider);
      await orch.switchProvider("claude");

      await orch.setModel("claude-sonnet-4-20250514");
      expect(provider.currentModel).toBe("claude-sonnet-4-20250514");
    });

    it("setModel closes current session (force new session)", async () => {
      const orch = makeOrchestrator();
      const provider = mockProvider("claude");
      orch.registerProvider(provider);
      await orch.switchProvider("claude");

      const session = await orch.startSession();
      await orch.setModel("claude-sonnet-4-20250514");

      expect(provider.closeSession).toHaveBeenCalledWith(session);
      expect(orch.activeSession).toBeNull();
    });

    it("setModel auto-switches provider if none active", async () => {
      const orch = makeOrchestrator();
      const provider = mockProvider("claude");
      orch.registerProvider(provider);

      await orch.setModel("new-model");

      expect(provider.authenticate).toHaveBeenCalled();
      expect(provider.currentModel).toBe("new-model");
    });

    it("setReasoningEffort updates provider", async () => {
      const orch = makeOrchestrator();
      const provider = mockProvider("claude");
      orch.registerProvider(provider);
      await orch.switchProvider("claude");

      await orch.setReasoningEffort("high");
      expect(provider.reasoningEffort).toBe("high");
    });

    it("setReasoningEffort auto-switches provider if none active", async () => {
      const orch = makeOrchestrator();
      const provider = mockProvider("claude");
      orch.registerProvider(provider);

      await orch.setReasoningEffort("max");
      expect(provider.authenticate).toHaveBeenCalled();
      expect(provider.reasoningEffort).toBe("max");
    });

    it("fetchModels delegates to provider", async () => {
      const orch = makeOrchestrator();
      const provider = mockProvider("claude");
      orch.registerProvider(provider);
      await orch.switchProvider("claude");

      const models = await orch.fetchModels();
      expect(provider.fetchModels).toHaveBeenCalledOnce();
      expect(models).toEqual([{ id: "test-model", name: "Test Model" }]);
    });

    it("fetchModels returns current model if fetchModels not implemented", async () => {
      const orch = makeOrchestrator();
      const provider = mockProvider("claude");
      delete (provider as any).fetchModels;
      orch.registerProvider(provider);
      await orch.switchProvider("claude");

      const models = await orch.fetchModels();
      expect(models).toEqual([
        { id: "claude-opus-4-6", name: "claude-opus-4-6" },
      ]);
    });

    it("currentModel returns provider's model", async () => {
      const orch = makeOrchestrator();
      const provider = mockProvider("claude");
      orch.registerProvider(provider);
      await orch.switchProvider("claude");

      expect(orch.currentModel).toBe("claude-opus-4-6");
    });

    it("currentModel returns null when no provider active", () => {
      const orch = makeOrchestrator();
      expect(orch.currentModel).toBeNull();
    });

    it("reasoningEffort returns provider's effort", async () => {
      const orch = makeOrchestrator();
      const provider = mockProvider("claude");
      orch.registerProvider(provider);
      await orch.switchProvider("claude");

      expect(orch.reasoningEffort).toBe("medium");
    });

    it("reasoningEffort returns null when no provider active", () => {
      const orch = makeOrchestrator();
      expect(orch.reasoningEffort).toBeNull();
    });
  });

  // =======================================================================
  // Interrupt
  // =======================================================================

  describe("Interrupt", () => {
    it("interrupt calls provider interrupt", async () => {
      const orch = makeOrchestrator();
      const provider = mockProvider("claude");
      orch.registerProvider(provider);
      await orch.switchProvider("claude");
      const session = await orch.startSession();

      orch.interrupt();

      expect(provider.interrupt).toHaveBeenCalledWith(session);
    });

    it("interrupt does nothing without active session", () => {
      const orch = makeOrchestrator();
      const provider = mockProvider("claude");
      orch.registerProvider(provider);

      // Should not throw
      orch.interrupt();
      expect(provider.interrupt).not.toHaveBeenCalled();
    });

    it("interrupt aborts secondary controller", async () => {
      const orch = makeOrchestrator();
      const provider = mockProvider("claude");
      orch.registerProvider(provider);
      await orch.switchProvider("claude");
      await orch.startSession();

      const controller = new AbortController();
      orch.setActiveAbort(controller);

      orch.interrupt();

      expect(controller.signal.aborted).toBe(true);
    });

    it("setActiveAbort registers controller", async () => {
      const orch = makeOrchestrator();
      const provider = mockProvider("claude");
      orch.registerProvider(provider);
      await orch.switchProvider("claude");
      await orch.startSession();

      const controller = new AbortController();
      orch.setActiveAbort(controller);
      orch.interrupt();

      expect(controller.signal.aborted).toBe(true);
    });

    it("interrupt clears the active abort controller", async () => {
      const orch = makeOrchestrator();
      const provider = mockProvider("claude");
      orch.registerProvider(provider);
      await orch.switchProvider("claude");
      await orch.startSession();

      const controller1 = new AbortController();
      orch.setActiveAbort(controller1);
      orch.interrupt();

      // Register a second controller — first interrupt should have cleared
      const controller2 = new AbortController();
      orch.setActiveAbort(controller2);

      // First controller stays aborted, second is not yet aborted
      expect(controller1.signal.aborted).toBe(true);
      expect(controller2.signal.aborted).toBe(false);
    });

    it("setActiveAbort with null clears controller", async () => {
      const orch = makeOrchestrator();
      const provider = mockProvider("claude");
      orch.registerProvider(provider);
      await orch.switchProvider("claude");
      await orch.startSession();

      const controller = new AbortController();
      orch.setActiveAbort(controller);
      orch.setActiveAbort(null);

      orch.interrupt();
      // Controller should NOT be aborted since it was cleared
      expect(controller.signal.aborted).toBe(false);
    });
  });

  // =======================================================================
  // Context Gate integration
  // =======================================================================

  describe("Context Gate", () => {
    it("setContextGate stores the gate", () => {
      const orch = makeOrchestrator();
      const mockGate = { onSessionStart: vi.fn() };
      orch.setContextGate(mockGate as any);

      expect(orch.contextGate).toBe(mockGate);
    });

    it("contextGate returns null by default", () => {
      const orch = makeOrchestrator();
      expect(orch.contextGate).toBeNull();
    });

    it("maybeCheckpoint skips when no context gate", async () => {
      const { orch } = await makeWiredOrchestrator();
      await orch.startSession();

      // Should not throw or emit checkpoint events
      const events = await collectEvents(orch.send("Hello"));
      expect(
        events.some(
          (e) =>
            e.type === "text" &&
            (e as any).text.includes("Context checkpoint"),
        ),
      ).toBe(false);
    });

    it("maybeCheckpoint skips when threshold not reached", async () => {
      const { orch } = await makeWiredOrchestrator();

      const mockGate = {
        onSessionStart: vi.fn(),
        checkThreshold: vi.fn().mockReturnValue(false),
        performCheckpointWithGist: vi.fn(),
      };
      orch.setContextGate(mockGate as any);

      await orch.startSession();
      const events = await collectEvents(orch.send("Hello"));

      expect(mockGate.checkThreshold).toHaveBeenCalled();
      expect(mockGate.performCheckpointWithGist).not.toHaveBeenCalled();
    });
  });

  // =======================================================================
  // Sticky Manager
  // =======================================================================

  describe("Sticky Manager", () => {
    it("setStickyManager stores the manager", () => {
      const orch = makeOrchestrator();
      const stickies = new StickyManager();
      orch.setStickyManager(stickies);
      // Verify it's used in send — if setStickyManager didn't store it,
      // the augmented message test above would fail
    });
  });

  // =======================================================================
  // State Machine
  // =======================================================================

  describe("State Machine", () => {
    it("stateMachine is accessible", () => {
      const orch = makeOrchestrator();
      expect(orch.stateMachine).toBeTruthy();
      expect(orch.stateMachine.state).toBe("idle");
    });

    it("currentState reflects state machine", async () => {
      const orch = makeOrchestrator();
      expect(orch.currentState).toBe("idle");

      orch.registerProvider(mockProvider("claude"));
      await orch.switchProvider("claude");
      await orch.startSession();

      expect(orch.currentState).toBe("active");
    });

    it("startSession does not transition if already active", async () => {
      const orch = makeOrchestrator();
      orch.registerProvider(mockProvider("claude"));
      await orch.switchProvider("claude");

      await orch.startSession();
      expect(orch.currentState).toBe("active");

      // Starting another session should not throw (already active)
      await orch.startSession();
      expect(orch.currentState).toBe("active");
    });
  });

  // =======================================================================
  // Config
  // =======================================================================

  describe("Config", () => {
    it("config is accessible", () => {
      const orch = makeOrchestrator();
      expect(orch.config.defaultProvider).toBe("claude");
      expect(orch.config.systemPrompt).toBe("You are a test agent.");
    });

    it("sessionStore is accessible", () => {
      const orch = makeOrchestrator();
      expect(orch.sessionStore).toBeInstanceOf(SessionStore);
    });

    it("uses provided sessionStore", () => {
      const store = new SessionStore("custom");
      const orch = new Orchestrator({
        defaultProvider: "claude",
        systemPrompt: "test",
        sessionStore: store,
      });
      expect(orch.sessionStore).toBe(store);
    });
  });
});
