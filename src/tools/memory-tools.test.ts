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

const { MemoryStore } = await import("../memory/memory-store.js");
const {
  createMemoryLsTool,
  createMemoryReadTool,
  createMemoryWriteTool,
  createMemoryRmTool,
  createMemoryTools,
} = await import("./memory-tools.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTools() {
  const memory = new MemoryStore("test-session");
  return {
    memory,
    ls: createMemoryLsTool(memory),
    read: createMemoryReadTool(memory),
    write: createMemoryWriteTool(memory),
    rm: createMemoryRmTool(memory),
  };
}

function parse(json: string): unknown {
  return JSON.parse(json);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("memory_ls", () => {
  beforeEach(() => {
    mockDb.current = createTestDb();
  });

  it("returns empty for empty directory", async () => {
    const { ls } = makeTools();
    const result = parse(await ls.execute({ path: "/" }));
    expect(result).toEqual({
      path: "/",
      children: [],
      note: "Empty directory",
    });
  });

  it("lists children with path and gist", async () => {
    const { ls, memory } = makeTools();
    memory.write("/goal", "Train model", "content");
    memory.write("/observations/lr", "LR finding", "content");

    const result = parse(await ls.execute({ path: "/" })) as any;
    expect(result.children.length).toBeGreaterThanOrEqual(2);
    const paths = result.children.map((c: any) => c.path);
    expect(paths).toContain("/goal");
  });

  it("marks directories vs files", async () => {
    const { ls, memory } = makeTools();
    memory.write("/experiments/", "Experiments dir");
    memory.write("/goal", "Goal", "content");

    const result = parse(await ls.execute({ path: "/" })) as any;
    const expDir = result.children.find((c: any) => c.path === "/experiments/");
    const goalFile = result.children.find((c: any) => c.path === "/goal");

    expect(expDir?.type).toBe("dir");
    expect(goalFile?.type).toBe("file");
  });

  it("defaults to '/' when no path given", async () => {
    const { ls, memory } = makeTools();
    memory.write("/a", "a", "content");

    const result = parse(await ls.execute({})) as any;
    expect(result.path).toBe("/");
    expect(result.children.length).toBeGreaterThanOrEqual(1);
  });

  it("returns valid JSON", async () => {
    const { ls, memory } = makeTools();
    memory.write("/x", "test", "content");
    const raw = await ls.execute({ path: "/" });
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it("lists subdirectory children", async () => {
    const { ls, memory } = makeTools();
    memory.write("/experiments/01", "baseline", "content");
    memory.write("/experiments/02", "sweep", "content");

    const result = parse(await ls.execute({ path: "/experiments/" })) as any;
    expect(result.children).toHaveLength(2);
  });

  it("includes gist in children", async () => {
    const { ls, memory } = makeTools();
    memory.write("/goal", "Train TinyStories", "content");

    const result = parse(await ls.execute({ path: "/" })) as any;
    const goal = result.children.find((c: any) => c.path === "/goal");
    expect(goal?.gist).toBe("Train TinyStories");
  });
});

describe("memory_read", () => {
  beforeEach(() => {
    mockDb.current = createTestDb();
  });

  it("reads node content", async () => {
    const { read, memory } = makeTools();
    memory.write("/goal", "Train model", "Full goal description");

    const result = parse(await read.execute({ path: "/goal" })) as any;
    expect(result.content).toBe("Full goal description");
  });

  it("returns error for missing path", async () => {
    const { read } = makeTools();
    const result = parse(await read.execute({ path: "/nonexistent" })) as any;
    expect(result.error).toBeDefined();
    expect(result.error).toContain("Not found");
  });

  it("includes all fields (path, gist, content, type, updated_at)", async () => {
    const { read, memory } = makeTools();
    memory.write("/goal", "Train model", "Content here");

    const result = parse(await read.execute({ path: "/goal" })) as any;
    expect(result.path).toBe("/goal");
    expect(result.gist).toBe("Train model");
    expect(result.content).toBe("Content here");
    expect(result.type).toBe("file");
    expect(typeof result.updated_at).toBe("number");
  });

  it("reads directories", async () => {
    const { read, memory } = makeTools();
    memory.write("/experiments/", "Experiments dir");

    const result = parse(await read.execute({ path: "/experiments/" })) as any;
    expect(result.type).toBe("dir");
    expect(result.content).toBeNull();
  });

  it("returns error string as JSON", async () => {
    const { read } = makeTools();
    const raw = await read.execute({ path: "/missing" });
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it("reads deeply nested node", async () => {
    const { read, memory } = makeTools();
    memory.write("/a/b/c/d", "deep", "deep content");

    const result = parse(await read.execute({ path: "/a/b/c/d" })) as any;
    expect(result.content).toBe("deep content");
  });

  it("returns gist from read", async () => {
    const { read, memory } = makeTools();
    memory.write("/obs", "Key observation", "details...");

    const result = parse(await read.execute({ path: "/obs" })) as any;
    expect(result.gist).toBe("Key observation");
  });
});

describe("memory_write", () => {
  beforeEach(() => {
    mockDb.current = createTestDb();
  });

  it("creates new node", async () => {
    const { write, memory } = makeTools();
    await write.execute({ path: "/goal", gist: "Train model", content: "Details" });

    const node = memory.read("/goal");
    expect(node).not.toBeNull();
    expect(node!.content).toBe("Details");
  });

  it("updates existing node", async () => {
    const { write, memory } = makeTools();
    await write.execute({ path: "/goal", gist: "v1", content: "old" });
    await write.execute({ path: "/goal", gist: "v2", content: "new" });

    const node = memory.read("/goal");
    expect(node!.gist).toBe("v2");
    expect(node!.content).toBe("new");
  });

  it("creates directory when no content", async () => {
    const { write, memory } = makeTools();
    await write.execute({ path: "/experiments/", gist: "Experiments" });

    const node = memory.read("/experiments/");
    expect(node).not.toBeNull();
    expect(node!.isDir).toBe(true);
    expect(node!.content).toBeNull();
  });

  it("returns ok response", async () => {
    const { write } = makeTools();
    const result = parse(await write.execute({ path: "/x", gist: "test", content: "c" })) as any;
    expect(result.ok).toBe(true);
    expect(result.path).toBe("/x");
    expect(result.gist).toBe("test");
  });

  it("auto-creates parents", async () => {
    const { write, memory } = makeTools();
    await write.execute({ path: "/a/b/c", gist: "deep", content: "content" });

    expect(memory.exists("/a/")).toBe(true);
    expect(memory.exists("/a/b/")).toBe(true);
  });

  it("returns valid JSON", async () => {
    const { write } = makeTools();
    const raw = await write.execute({ path: "/x", gist: "g", content: "c" });
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it("handles special characters in content", async () => {
    const { write, memory } = makeTools();
    const specialContent = 'line1\nline2\ttab\n{"json": true}';
    await write.execute({ path: "/special", gist: "special", content: specialContent });

    const node = memory.read("/special");
    expect(node!.content).toBe(specialContent);
  });
});

describe("memory_rm", () => {
  beforeEach(() => {
    mockDb.current = createTestDb();
  });

  it("removes node", async () => {
    const { rm, memory } = makeTools();
    memory.write("/goal", "test", "content");

    const result = parse(await rm.execute({ path: "/goal" })) as any;
    expect(result.ok).toBe(true);
    expect(result.removed_count).toBeGreaterThan(0);
    expect(memory.exists("/goal")).toBe(false);
  });

  it("removes directory and children", async () => {
    const { rm, memory } = makeTools();
    memory.write("/exp/01", "a", "content");
    memory.write("/exp/02", "b", "content");

    const result = parse(await rm.execute({ path: "/exp/" })) as any;
    expect(result.removed_count).toBeGreaterThanOrEqual(2);
    expect(memory.exists("/exp/01")).toBe(false);
    expect(memory.exists("/exp/02")).toBe(false);
  });

  it("returns removal count", async () => {
    const { rm, memory } = makeTools();
    memory.write("/a", "a", "c");
    memory.write("/b", "b", "c");

    const r1 = parse(await rm.execute({ path: "/a" })) as any;
    expect(r1.removed_count).toBe(1);
  });

  it("returns 0 for non-existent path", async () => {
    const { rm } = makeTools();
    const result = parse(await rm.execute({ path: "/nonexistent" })) as any;
    expect(result.removed_count).toBe(0);
  });

  it("returns valid JSON", async () => {
    const { rm } = makeTools();
    const raw = await rm.execute({ path: "/nothing" });
    expect(() => JSON.parse(raw)).not.toThrow();
  });
});

describe("createMemoryTools", () => {
  beforeEach(() => {
    mockDb.current = createTestDb();
  });

  it("returns 4 tools", () => {
    const memory = new MemoryStore("test-session");
    const tools = createMemoryTools(memory);
    expect(tools).toHaveLength(4);
  });

  it("tools have correct names", () => {
    const memory = new MemoryStore("test-session");
    const tools = createMemoryTools(memory);
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["memory_ls", "memory_read", "memory_rm", "memory_write"]);
  });

  it("all tools have execute functions", () => {
    const memory = new MemoryStore("test-session");
    const tools = createMemoryTools(memory);
    for (const tool of tools) {
      expect(typeof tool.execute).toBe("function");
    }
  });

  it("all tools have descriptions", () => {
    const memory = new MemoryStore("test-session");
    const tools = createMemoryTools(memory);
    for (const tool of tools) {
      expect(tool.description.length).toBeGreaterThan(0);
    }
  });
});
