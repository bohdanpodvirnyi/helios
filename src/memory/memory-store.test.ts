import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb } from "../__tests__/db-helper.js";

// Mock getDb before importing MemoryStore
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

describe("MemoryStore", () => {
  beforeEach(() => {
    mockDb.current = createTestDb();
  });

  it("starts empty", () => {
    const store = new MemoryStore("sess1");
    expect(store.count()).toBe(0);
    expect(store.ls("/")).toEqual([]);
  });

  it("writes and reads a node", () => {
    const store = new MemoryStore("sess1");
    store.write("/goal", "Train TinyStories", "Full goal description here");

    const node = store.read("/goal");
    expect(node).not.toBeNull();
    expect(node!.path).toBe("/goal");
    expect(node!.gist).toBe("Train TinyStories");
    expect(node!.content).toBe("Full goal description here");
    expect(node!.isDir).toBe(false);
  });

  it("writes directories when content is null", () => {
    const store = new MemoryStore("sess1");
    store.write("/experiments/", "Experiment results");

    const node = store.read("/experiments/");
    expect(node!.isDir).toBe(true);
    expect(node!.content).toBeNull();
  });

  it("auto-creates parent directories", () => {
    const store = new MemoryStore("sess1");
    store.write("/experiments/01-baseline", "baseline", "lr=0.01, loss=2.3");

    expect(store.exists("/experiments/")).toBe(true);
    const parent = store.read("/experiments/");
    expect(parent!.isDir).toBe(true);
  });

  it("lists children of a directory", () => {
    const store = new MemoryStore("sess1");
    store.write("/experiments/01", "baseline", "content");
    store.write("/experiments/02", "lr-sweep", "content");
    store.write("/goal", "train", "content");

    const children = store.ls("/experiments/");
    expect(children).toHaveLength(2);
    expect(children.map((c) => c.path).sort()).toEqual([
      "/experiments/01",
      "/experiments/02",
    ]);
  });

  it("ls returns only direct children", () => {
    const store = new MemoryStore("sess1");
    store.write("/a/b/c", "deep", "content");

    const root = store.ls("/");
    // Should only see /a/, not /a/b/ or /a/b/c
    expect(root.map((c) => c.path)).toEqual(["/a/"]);
  });

  it("tree returns all descendants", () => {
    const store = new MemoryStore("sess1");
    store.write("/a/b/c", "deep node", "content");

    const nodes = store.tree("/");
    expect(nodes.length).toBeGreaterThanOrEqual(2); // /a/ and /a/b/c at minimum
  });

  it("removes a node", () => {
    const store = new MemoryStore("sess1");
    store.write("/goal", "test", "content");
    expect(store.exists("/goal")).toBe(true);

    const removed = store.rm("/goal");
    expect(removed).toBeGreaterThan(0);
    expect(store.exists("/goal")).toBe(false);
  });

  it("removes directory and all children", () => {
    const store = new MemoryStore("sess1");
    store.write("/exp/01", "a", "content");
    store.write("/exp/02", "b", "content");

    store.rm("/exp/");
    expect(store.exists("/exp/01")).toBe(false);
    expect(store.exists("/exp/02")).toBe(false);
  });

  it("upserts on write", () => {
    const store = new MemoryStore("sess1");
    store.write("/goal", "v1", "old");
    store.write("/goal", "v2", "new");

    const node = store.read("/goal");
    expect(node!.gist).toBe("v2");
    expect(node!.content).toBe("new");
    expect(store.count()).toBe(1);
  });

  it("isolates sessions", () => {
    const store1 = new MemoryStore("sess1");
    const store2 = new MemoryStore("sess2");

    store1.write("/goal", "session 1 goal", "content");
    expect(store2.read("/goal")).toBeNull();
    expect(store2.count()).toBe(0);
  });

  it("formatTree produces readable output", () => {
    const store = new MemoryStore("sess1");
    store.write("/goal", "Train model", "content");
    store.write("/experiments/01", "baseline", "content");

    const tree = store.formatTree("/");
    expect(tree).toContain("goal:");
    expect(tree).toContain("01:");
  });

  it("formatTree returns (empty) for empty store", () => {
    const store = new MemoryStore("sess1");
    expect(store.formatTree("/")).toBe("(empty)");
  });

  it("clear removes all session data", () => {
    const store = new MemoryStore("sess1");
    store.write("/a", "a", "content");
    store.write("/b", "b", "content");

    store.clear();
    expect(store.count()).toBe(0);
  });

  it("validates paths — normalizes ..", () => {
    const store = new MemoryStore("sess1");
    store.write("/a/../b", "test", "content");

    // Should resolve to /b
    expect(store.exists("/b")).toBe(true);
    expect(store.exists("/a/../b")).toBe(true); // same after normalization
  });

  it("setSession changes the active session", () => {
    const store = new MemoryStore("sess1");
    store.write("/x", "gist", "content");

    store.setSession("sess2");
    expect(store.read("/x")).toBeNull(); // different session
  });
});
