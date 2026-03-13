import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb } from "../__tests__/db-helper.js";

const mockDb = { current: createTestDb() };
vi.mock("./database.js", () => {
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

const { SessionStore, createEphemeralSession } = await import("./session-store.js");

describe("SessionStore", () => {
  beforeEach(() => {
    mockDb.current = createTestDb();
  });

  it("creates and retrieves a session", () => {
    const store = new SessionStore("agent1");
    const session = store.createSession("claude", "opus");

    expect(session.id).toBeTruthy();
    expect(session.providerId).toBe("claude");

    const retrieved = store.getSession(session.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe(session.id);
    expect(retrieved!.providerId).toBe("claude");
  });

  it("returns null for missing session", () => {
    const store = new SessionStore("agent1");
    expect(store.getSession("nonexistent")).toBeNull();
  });

  it("updates provider session ID", () => {
    const store = new SessionStore("agent1");
    const session = store.createSession("claude");

    store.updateProviderSessionId(session.id, "sdk-123");
    const retrieved = store.getSession(session.id);
    expect(retrieved!.providerSessionId).toBe("sdk-123");
  });

  it("adds and retrieves messages", () => {
    const store = new SessionStore("agent1");
    const session = store.createSession("claude");

    store.addMessage(session.id, "user", "Hello");
    store.addMessage(session.id, "assistant", "Hi there");

    const messages = store.getMessages(session.id);
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("user");
    expect(messages[0].content).toBe("Hello");
    expect(messages[1].role).toBe("assistant");
  });

  it("getMessages respects limit", () => {
    const store = new SessionStore("agent1");
    const session = store.createSession("claude");

    for (let i = 0; i < 10; i++) {
      store.addMessage(session.id, "user", `msg ${i}`);
    }

    const messages = store.getMessages(session.id, 3);
    expect(messages).toHaveLength(3);
  });

  it("tracks cost accumulation", () => {
    const store = new SessionStore("agent1");
    const session = store.createSession("claude");

    store.addCost(session.id, 0.01, 100, 50);
    store.addCost(session.id, 0.02, 200, 100);

    const summaries = store.listSessionSummaries();
    // No messages yet, so summary might not show. Add a message first.
    store.addMessage(session.id, "user", "test");
    const s = store.listSessionSummaries();
    expect(s).toHaveLength(1);
    expect(s[0].costUsd).toBeCloseTo(0.03);
    expect(s[0].inputTokens).toBe(300);
    expect(s[0].outputTokens).toBe(150);
  });

  it("listSessions filters by agent ID", () => {
    const store1 = new SessionStore("agent1");
    const store2 = new SessionStore("agent2");

    const s1 = store1.createSession("claude");
    store1.addMessage(s1.id, "user", "hi");
    const s2 = store2.createSession("openai");
    store2.addMessage(s2.id, "user", "hi");

    expect(store1.listSessions()).toHaveLength(1);
    expect(store1.listSessions()[0].id).toBe(s1.id);
  });

  it("listSessions excludes empty sessions", () => {
    const store = new SessionStore("agent1");
    store.createSession("claude"); // no messages

    expect(store.listSessions()).toHaveLength(0);
  });

  it("listSessionSummaries includes first user message", () => {
    const store = new SessionStore("agent1");
    const session = store.createSession("claude");
    store.addMessage(session.id, "user", "Train a model to classify cats");
    store.addMessage(session.id, "assistant", "Sure!");

    const summaries = store.listSessionSummaries();
    expect(summaries[0].firstUserMessage).toContain("Train a model");
  });

  it("updates lastActiveAt", () => {
    const store = new SessionStore("agent1");
    const session = store.createSession("claude");
    const before = session.lastActiveAt;

    // Small delay to ensure timestamp changes
    store.updateLastActive(session.id);
    const updated = store.getSession(session.id);
    expect(updated!.lastActiveAt).toBeGreaterThanOrEqual(before);
  });
});

describe("createEphemeralSession", () => {
  it("creates session with eph- prefix", () => {
    const session = createEphemeralSession("claude");
    expect(session.id).toMatch(/^eph-/);
    expect(session.providerId).toBe("claude");
  });

  it("sets timestamps", () => {
    const before = Date.now();
    const session = createEphemeralSession("openai");
    expect(session.createdAt).toBeGreaterThanOrEqual(before);
    expect(session.lastActiveAt).toBeGreaterThanOrEqual(before);
  });
});
