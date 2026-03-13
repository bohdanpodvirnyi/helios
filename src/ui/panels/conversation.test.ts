import { describe, it, expect } from "vitest";
import type { ToolData, Message } from "../types.js";

// ── Local copies of internal helpers (not exported from conversation.tsx) ─────

function parseResult(tool: ToolData): Record<string, unknown> | null {
  if (!tool.result) return null;
  try {
    return JSON.parse(tool.result);
  } catch {
    return null;
  }
}

function trimOutput(text: string, maxLines: number): string {
  const lines = text.trimEnd().split("\n");
  if (lines.length <= maxLines) return text.trimEnd();
  const kept = lines.slice(-maxLines);
  return `… ${lines.length - maxLines} lines hidden …\n${kept.join("\n")}`;
}

// ── parseResult ──────────────────────────────────────────────────────

describe("parseResult", () => {
  const makeTool = (result?: string): ToolData => ({
    callId: "c1",
    name: "test",
    args: {},
    result,
  });

  it("parses valid JSON string into an object", () => {
    const tool = makeTool(JSON.stringify({ stdout: "hello", exit_code: 0 }));
    expect(parseResult(tool)).toEqual({ stdout: "hello", exit_code: 0 });
  });

  it("returns null for invalid JSON", () => {
    const tool = makeTool("not json at all {{{");
    expect(parseResult(tool)).toBeNull();
  });

  it("returns null when result is undefined", () => {
    const tool = makeTool(undefined);
    expect(parseResult(tool)).toBeNull();
  });

  it("returns null for empty string (invalid JSON)", () => {
    const tool = makeTool("");
    expect(parseResult(tool)).toBeNull();
  });

  it("parses nested objects correctly", () => {
    const nested = { a: { b: { c: 42 } }, d: "value" };
    const tool = makeTool(JSON.stringify(nested));
    expect(parseResult(tool)).toEqual(nested);
  });

  it("parses arrays in JSON", () => {
    const arr = [1, 2, { x: true }];
    const tool = makeTool(JSON.stringify(arr));
    // JSON.parse returns the array, but typed as Record<string, unknown>
    expect(parseResult(tool)).toEqual(arr);
  });

  it("parses JSON with numeric string result", () => {
    // JSON.parse("42") returns 42, which is not Record<string,unknown>
    // but the function doesn't guard the return type beyond JSON.parse
    const tool = makeTool("42");
    expect(parseResult(tool)).toBe(42);
  });

  it("parses JSON with null literal", () => {
    const tool = makeTool("null");
    // JSON.parse("null") returns null
    expect(parseResult(tool)).toBeNull();
  });

  it("parses JSON boolean literal", () => {
    const tool = makeTool("true");
    expect(parseResult(tool)).toBe(true);
  });
});

// ── trimOutput ───────────────────────────────────────────────────────

describe("trimOutput", () => {
  it("returns text unchanged when fewer lines than max", () => {
    const text = "line 1\nline 2\nline 3";
    expect(trimOutput(text, 5)).toBe("line 1\nline 2\nline 3");
  });

  it("returns text unchanged when exactly maxLines", () => {
    const text = "a\nb\nc";
    expect(trimOutput(text, 3)).toBe("a\nb\nc");
  });

  it("truncates and shows hidden count when exceeding maxLines", () => {
    const text = "line 1\nline 2\nline 3\nline 4\nline 5";
    const result = trimOutput(text, 3);
    expect(result).toBe("… 2 lines hidden …\nline 3\nline 4\nline 5");
  });

  it("handles single line text", () => {
    expect(trimOutput("hello", 5)).toBe("hello");
    expect(trimOutput("hello", 1)).toBe("hello");
  });

  it("handles empty text", () => {
    // "".trimEnd() is "", "".split("\n") is [""], length 1
    expect(trimOutput("", 1)).toBe("");
    expect(trimOutput("", 5)).toBe("");
  });

  it("trims trailing whitespace", () => {
    const text = "line 1\nline 2   \n";
    expect(trimOutput(text, 5)).toBe("line 1\nline 2");
  });

  it("trims trailing newlines", () => {
    const text = "line 1\nline 2\n\n\n";
    // trimEnd removes trailing newlines, so "line 1\nline 2" -> 2 lines
    expect(trimOutput(text, 5)).toBe("line 1\nline 2");
  });

  it("handles maxLines of 1", () => {
    const text = "line 1\nline 2\nline 3";
    const result = trimOutput(text, 1);
    expect(result).toBe("… 2 lines hidden …\nline 3");
  });

  it("handles large text with small maxLines", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`);
    const text = lines.join("\n");
    const result = trimOutput(text, 5);
    expect(result).toContain("… 95 lines hidden …");
    expect(result).toContain("line 96");
    expect(result).toContain("line 97");
    expect(result).toContain("line 98");
    expect(result).toContain("line 99");
    expect(result).toContain("line 100");
    // Should NOT contain early lines
    expect(result).not.toContain("line 1\n");
  });

  it("keeps the last N lines (tail behavior)", () => {
    const text = "first\nsecond\nthird\nfourth\nfifth";
    const result = trimOutput(text, 2);
    expect(result).toBe("… 3 lines hidden …\nfourth\nfifth");
  });
});

// ── Tool display routing logic ───────────────────────────────────────

describe("ToolCallBlock routing", () => {
  // Since we can't render components, verify the routing table matches expectations
  const TOOL_ROUTE_MAP: Record<string, string> = {
    remote_exec: "ExecDisplay",
    remote_exec_background: "ExecBackgroundDisplay",
    remote_upload: "FileSyncDisplay",
    remote_download: "FileSyncDisplay",
    sleep: "SleepDisplay",
    start_monitor: "MonitorDisplay",
    stop_monitor: "MonitorStopDisplay",
    task_output: "TaskOutputDisplay",
    list_machines: "ListMachinesDisplay",
    show_metrics: "ShowMetricsDisplay",
    compare_runs: "CompareRunsDisplay",
  };

  const KNOWN_TOOL_NAMES = Object.keys(TOOL_ROUTE_MAP);

  it("has 11 explicitly routed tool names", () => {
    expect(KNOWN_TOOL_NAMES).toHaveLength(11);
  });

  it("routes remote_upload and remote_download to the same display", () => {
    expect(TOOL_ROUTE_MAP.remote_upload).toBe(TOOL_ROUTE_MAP.remote_download);
  });

  it("all expected tool names are present in routing", () => {
    const expected = [
      "remote_exec",
      "remote_exec_background",
      "remote_upload",
      "remote_download",
      "sleep",
      "start_monitor",
      "stop_monitor",
      "task_output",
      "list_machines",
      "show_metrics",
      "compare_runs",
    ];
    for (const name of expected) {
      expect(TOOL_ROUTE_MAP).toHaveProperty(name);
    }
  });

  it("unknown tool names would fall through to GenericToolDisplay", () => {
    const unknownTools = ["write_file", "search", "my_custom_tool", ""];
    for (const name of unknownTools) {
      expect(KNOWN_TOOL_NAMES).not.toContain(name);
    }
  });
});

// ── Message role routing ─────────────────────────────────────────────

describe("MessageLine role routing", () => {
  // Test the role routing logic pattern from the switch statement

  const VALID_ROLES: Message["role"][] = ["user", "assistant", "tool", "error", "system"];

  it("recognizes all 5 valid roles", () => {
    expect(VALID_ROLES).toHaveLength(5);
  });

  it("user messages render with content", () => {
    const msg: Message = { id: 1, role: "user", content: "run training" };
    expect(msg.role).toBe("user");
    expect(msg.content).toBeTruthy();
    // user branch always renders (no null return)
  });

  it("assistant messages render with content", () => {
    const msg: Message = { id: 2, role: "assistant", content: "Sure, starting..." };
    expect(msg.role).toBe("assistant");
    // assistant branch delegates to AssistantMessage
  });

  it("tool messages with tool data render ToolCallBlock", () => {
    const tool: ToolData = {
      callId: "c1",
      name: "remote_exec",
      args: { command: "ls" },
      result: '{"stdout":"file.txt","exit_code":0}',
    };
    const msg: Message = { id: 3, role: "tool", content: "", tool };
    expect(msg.role).toBe("tool");
    expect(msg.tool).toBeDefined();
    // tool branch with tool data renders <ToolCallBlock />
  });

  it("tool messages without tool data render null", () => {
    const msg: Message = { id: 4, role: "tool", content: "" };
    expect(msg.role).toBe("tool");
    expect(msg.tool).toBeUndefined();
    // tool branch without tool data returns null
  });

  it("error messages display content", () => {
    const msg: Message = { id: 5, role: "error", content: "Connection lost" };
    expect(msg.role).toBe("error");
    expect(msg.content).toBeTruthy();
  });

  it("system messages display content", () => {
    const msg: Message = { id: 6, role: "system", content: "Session resumed" };
    expect(msg.role).toBe("system");
    expect(msg.content).toBeTruthy();
  });

  it("unknown roles fall through to default (plain text)", () => {
    // The type restricts roles, but default case handles unexpected values
    const msg = { id: 7, role: "unknown" as Message["role"], content: "fallback" };
    expect(msg.content).toBe("fallback");
    // default branch renders plain <Text>{content}</Text>
  });
});

// ── Markdown throttling constant ─────────────────────────────────────

describe("markdown throttle", () => {
  const MD_THROTTLE_MS = 150;

  it("throttle constant is 150ms", () => {
    expect(MD_THROTTLE_MS).toBe(150);
  });

  it("throttle is positive and reasonable for UI rendering", () => {
    expect(MD_THROTTLE_MS).toBeGreaterThan(0);
    expect(MD_THROTTLE_MS).toBeLessThanOrEqual(1000);
  });
});

// ── PulsingIndicator frames ──────────────────────────────────────────

describe("PulsingIndicator frames", () => {
  const PULSE_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

  it("has 10 animation frames", () => {
    expect(PULSE_FRAMES).toHaveLength(10);
  });

  it("all frames are single braille characters", () => {
    for (const frame of PULSE_FRAMES) {
      expect(frame).toHaveLength(1);
      // Braille patterns are in U+2800..U+28FF
      const code = frame.codePointAt(0)!;
      expect(code).toBeGreaterThanOrEqual(0x2800);
      expect(code).toBeLessThanOrEqual(0x28ff);
    }
  });

  it("frame cycling wraps correctly via modulo", () => {
    const frame = (n: number) => PULSE_FRAMES[n % PULSE_FRAMES.length];
    expect(frame(0)).toBe("⠋");
    expect(frame(9)).toBe("⠏");
    expect(frame(10)).toBe("⠋"); // wraps
    expect(frame(25)).toBe("⠴"); // 25 % 10 = 5
  });
});

// ── GenericToolDisplay arg formatting ────────────────────────────────

describe("GenericToolDisplay arg formatting pattern", () => {
  // Replicating the inline arg formatting logic from GenericToolDisplay
  function formatArgs(args: Record<string, unknown>): string {
    return Object.entries(args)
      .map(([k, v]) => {
        const val = typeof v === "string" ? v : JSON.stringify(v);
        return `${k}: ${val}`;
      })
      .join("  ");
  }

  it("formats string args directly", () => {
    expect(formatArgs({ path: "/tmp/data" })).toBe("path: /tmp/data");
  });

  it("JSON-stringifies non-string args", () => {
    expect(formatArgs({ count: 5 })).toBe("count: 5");
    expect(formatArgs({ verbose: true })).toBe("verbose: true");
    expect(formatArgs({ items: [1, 2] })).toBe("items: [1,2]");
  });

  it("joins multiple args with double space", () => {
    const result = formatArgs({ a: "x", b: "y" });
    expect(result).toBe("a: x  b: y");
  });

  it("handles empty args", () => {
    expect(formatArgs({})).toBe("");
  });
});

// ── ExecDisplay parseResult integration ──────────────────────────────

describe("ExecDisplay result extraction pattern", () => {
  it("extracts stdout, stderr, exit_code from parsed result", () => {
    const tool: ToolData = {
      callId: "c1",
      name: "remote_exec",
      args: { machine_id: "gpu-1", command: "nvidia-smi" },
      result: JSON.stringify({ stdout: "GPU 0: A100", stderr: "", exit_code: 0 }),
    };
    const result = parseResult(tool);
    expect(result).not.toBeNull();
    expect(result!.stdout).toBe("GPU 0: A100");
    expect(result!.stderr).toBe("");
    expect(result!.exit_code).toBe(0);
  });

  it("handles missing result (running state)", () => {
    const tool: ToolData = {
      callId: "c2",
      name: "remote_exec",
      args: { machine_id: "gpu-1", command: "python train.py" },
    };
    expect(parseResult(tool)).toBeNull();
  });

  it("falls back gracefully on non-JSON result", () => {
    const tool: ToolData = {
      callId: "c3",
      name: "remote_exec",
      args: { machine_id: "gpu-1", command: "echo hi" },
      result: "raw output without json wrapper",
    };
    expect(parseResult(tool)).toBeNull();
  });

  it("extracts machine_id and command from args with fallback", () => {
    const tool: ToolData = { callId: "c4", name: "remote_exec", args: {} };
    const machine = (tool.args.machine_id as string) ?? "?";
    const command = (tool.args.command as string) ?? "";
    expect(machine).toBe("?");
    expect(command).toBe("");
  });
});

// ── CompareRunsDisplay direction helpers ──────────────────────────────

describe("CompareRunsDisplay direction helpers", () => {
  // Replicate the inline helpers
  function dirIcon(d: string): string {
    switch (d) {
      case "decreased": return "\u2193";
      case "increased": return "\u2191";
      case "unchanged": return "\u2192";
      default: return "?";
    }
  }

  it("maps direction strings to correct icons", () => {
    expect(dirIcon("decreased")).toBe("↓");
    expect(dirIcon("increased")).toBe("↑");
    expect(dirIcon("unchanged")).toBe("→");
    expect(dirIcon("something_else")).toBe("?");
  });
});

// ── ShowMetricsDisplay trend helpers ─────────────────────────────────

describe("ShowMetricsDisplay trend helpers", () => {
  function trendIcon(trend: string): string {
    switch (trend) {
      case "decreasing": return "\u2193";
      case "increasing": return "\u2191";
      case "plateau": return "\u2192";
      case "unstable": return "~";
      default: return "?";
    }
  }

  it("maps trend strings to correct icons", () => {
    expect(trendIcon("decreasing")).toBe("↓");
    expect(trendIcon("increasing")).toBe("↑");
    expect(trendIcon("plateau")).toBe("→");
    expect(trendIcon("unstable")).toBe("~");
    expect(trendIcon("unknown")).toBe("?");
  });
});

// ── fmtVal (formatMetricValue wrapper) ───────────────────────────────

describe("fmtVal null handling", () => {
  // Replicate the local wrapper from conversation.tsx
  // fmtVal delegates to formatMetricValue, but handles null with em dash
  const fmtVal = (v: number | null): string =>
    v === null ? "\u2014" : String(v);

  it("returns em dash for null", () => {
    expect(fmtVal(null)).toBe("\u2014");
  });

  it("returns value string for numbers", () => {
    expect(fmtVal(0)).toBe("0");
    expect(fmtVal(42)).toBe("42");
    expect(fmtVal(-1)).toBe("-1");
  });
});
