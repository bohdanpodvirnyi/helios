import { describe, it, expect, vi, beforeEach } from "vitest";
import { mergeWithGlobalPrefs } from "./project.js";

// ---------------------------------------------------------------------------
// mergeWithGlobalPrefs — pure function, no mocks needed
// ---------------------------------------------------------------------------

describe("mergeWithGlobalPrefs", () => {
  it("project provider takes precedence", () => {
    const result = mergeWithGlobalPrefs(
      { provider: "openai" },
      { lastProvider: "claude" },
    );
    expect(result.provider).toBe("openai");
  });

  it("falls back to global lastProvider", () => {
    const result = mergeWithGlobalPrefs(null, { lastProvider: "claude" });
    expect(result.provider).toBe("claude");
  });

  it("falls back to global lastProvider openai", () => {
    const result = mergeWithGlobalPrefs({}, { lastProvider: "openai" });
    expect(result.provider).toBe("openai");
  });

  it("ignores invalid lastProvider values", () => {
    const result = mergeWithGlobalPrefs(null, { lastProvider: "invalid" });
    expect(result.provider).toBeUndefined();
  });

  it("returns claudeMode from global prefs", () => {
    const result = mergeWithGlobalPrefs(null, { claudeAuthMode: "cli" });
    expect(result.claudeMode).toBe("cli");
  });

  it("returns claudeMode api from global prefs", () => {
    const result = mergeWithGlobalPrefs(null, { claudeAuthMode: "api" });
    expect(result.claudeMode).toBe("api");
  });

  it("ignores invalid claudeAuthMode", () => {
    const result = mergeWithGlobalPrefs(null, { claudeAuthMode: "invalid" });
    expect(result.claudeMode).toBeUndefined();
  });

  it("project model is used", () => {
    const result = mergeWithGlobalPrefs(
      { model: "claude-opus-4-6" },
      {},
    );
    expect(result.model).toBe("claude-opus-4-6");
  });

  it("returns empty object when all null/undefined", () => {
    const result = mergeWithGlobalPrefs(null, {});
    expect(result).toEqual({});
  });

  it("both project and global set: project provider wins", () => {
    const result = mergeWithGlobalPrefs(
      { provider: "claude" },
      { lastProvider: "openai" },
    );
    expect(result.provider).toBe("claude");
  });

  it("claude auth mode not in project config — from global only", () => {
    const result = mergeWithGlobalPrefs(
      { provider: "claude", model: "claude-opus-4-6" },
      { claudeAuthMode: "api" },
    );
    expect(result.claudeMode).toBe("api");
    expect(result.provider).toBe("claude");
  });

  it("returns model only from project config", () => {
    // global prefs don't have a model field
    const result = mergeWithGlobalPrefs(null, { lastProvider: "claude" });
    expect(result.model).toBeUndefined();
  });

  it("handles project config with no provider or model", () => {
    const result = mergeWithGlobalPrefs(
      { instructions: "custom instruction" },
      { lastProvider: "openai", claudeAuthMode: "cli" },
    );
    expect(result.provider).toBe("openai");
    expect(result.claudeMode).toBe("cli");
    expect(result.model).toBeUndefined();
  });

  it("all fields set: project provider, global claudeMode, project model", () => {
    const result = mergeWithGlobalPrefs(
      { provider: "openai", model: "gpt-5.4" },
      { lastProvider: "claude", claudeAuthMode: "api" },
    );
    expect(result.provider).toBe("openai");
    expect(result.claudeMode).toBe("api");
    expect(result.model).toBe("gpt-5.4");
  });

  it("empty project config falls back entirely to global", () => {
    const result = mergeWithGlobalPrefs({}, { lastProvider: "claude", claudeAuthMode: "cli" });
    expect(result.provider).toBe("claude");
    expect(result.claudeMode).toBe("cli");
  });
});

// ---------------------------------------------------------------------------
// writeProjectConfig — mock fs
// ---------------------------------------------------------------------------

vi.mock("node:fs", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    writeFileSync: vi.fn(),
    readFileSync: vi.fn(),
    existsSync: vi.fn(),
  };
});

// Must re-import after mocking fs so the module uses our mocked functions
const { writeProjectConfig, findProjectConfig, findProjectRoot, findProjectConfigPath } = await import("./project.js");

import { writeFileSync, readFileSync, existsSync } from "node:fs";

describe("writeProjectConfig", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("writes JSON to target path", () => {
    writeProjectConfig("/home/user/project", { provider: "claude" });

    expect(writeFileSync).toHaveBeenCalledTimes(1);
    const [path, content, encoding] = (writeFileSync as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(path).toContain("helios.json");
    expect(path).toContain("/home/user/project");
    expect(encoding).toBe("utf-8");
  });

  it("writes pretty-printed JSON", () => {
    const config = { provider: "openai" as const, model: "gpt-5.4" };
    writeProjectConfig("/tmp", config);

    const [, content] = (writeFileSync as ReturnType<typeof vi.fn>).mock.calls[0];
    const parsed = JSON.parse(content);
    expect(parsed.provider).toBe("openai");
    expect(parsed.model).toBe("gpt-5.4");
    // Verify it's pretty-printed (has newlines)
    expect(content).toContain("\n");
  });

  it("appends trailing newline to file", () => {
    writeProjectConfig("/tmp", { provider: "claude" });

    const [, content] = (writeFileSync as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(content.endsWith("\n")).toBe(true);
  });

  it("writes empty config as valid JSON", () => {
    writeProjectConfig("/tmp", {});

    const [, content] = (writeFileSync as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(() => JSON.parse(content)).not.toThrow();
    expect(JSON.parse(content)).toEqual({});
  });

  it("preserves all config fields", () => {
    const config = {
      provider: "claude" as const,
      model: "claude-opus-4-6",
      metricNames: ["loss", "accuracy"],
      instructions: "Be helpful",
    };
    writeProjectConfig("/tmp", config);

    const [, content] = (writeFileSync as ReturnType<typeof vi.fn>).mock.calls[0];
    const parsed = JSON.parse(content);
    expect(parsed.provider).toBe("claude");
    expect(parsed.model).toBe("claude-opus-4-6");
    expect(parsed.metricNames).toEqual(["loss", "accuracy"]);
    expect(parsed.instructions).toBe("Be helpful");
  });
});

// ---------------------------------------------------------------------------
// findProjectConfig / findProjectRoot / findProjectConfigPath
// ---------------------------------------------------------------------------

describe("findProjectConfig", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when no config found", () => {
    (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);

    const result = findProjectConfig();
    expect(result).toBeNull();
  });

  it("returns parsed config when found", () => {
    const cwd = process.cwd();
    (existsSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) => {
      return p === `${cwd}/helios.json`;
    });
    (readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
      JSON.stringify({ provider: "openai", model: "gpt-5.4" }),
    );

    const result = findProjectConfig();
    expect(result).not.toBeNull();
    expect(result!.provider).toBe("openai");
    expect(result!.model).toBe("gpt-5.4");
  });

  it("returns null on JSON parse error", () => {
    const cwd = process.cwd();
    (existsSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) => {
      return p === `${cwd}/helios.json`;
    });
    (readFileSync as ReturnType<typeof vi.fn>).mockReturnValue("not json at all {{{");

    const result = findProjectConfig();
    expect(result).toBeNull();
  });
});

describe("findProjectRoot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when no config found", () => {
    (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);
    const result = findProjectRoot();
    expect(result).toBeNull();
  });

  it("returns directory containing helios.json", () => {
    const cwd = process.cwd();
    (existsSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) => {
      return p === `${cwd}/helios.json`;
    });

    const result = findProjectRoot();
    expect(result).toBe(cwd);
  });
});

describe("findProjectConfigPath", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when no config found", () => {
    (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);
    const result = findProjectConfigPath();
    expect(result).toBeNull();
  });

  it("returns full path to helios.json", () => {
    const cwd = process.cwd();
    (existsSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) => {
      return p === `${cwd}/helios.json`;
    });

    const result = findProjectConfigPath();
    expect(result).toBe(`${cwd}/helios.json`);
  });

  it("walks up to find config in parent", () => {
    const cwd = process.cwd();
    const parts = cwd.split("/");
    const parent = parts.slice(0, -1).join("/");

    (existsSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) => {
      // Only found in parent directory
      return p === `${parent}/helios.json`;
    });

    const result = findProjectConfigPath();
    expect(result).toBe(`${parent}/helios.json`);
  });
});
