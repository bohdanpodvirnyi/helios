import { describe, it, expect } from "vitest";

/**
 * Pure-logic tests for TaskOverlay.
 *
 * We replicate the selection clamping, navigation bounds,
 * empty-state handling, layout calculations, and output fetching patterns.
 */

// ─── Types (subset of TaskInfo) ─────────────────────────

interface TaskInfo {
  id: string;
  name: string;
  status: "running" | "completed" | "failed";
  machineId: string;
  pid?: number;
  startedAt: number;
}

// ─── Selection Logic ────────────────────────────────────

function selectionUp(current: number, tasksLength: number): number {
  if (tasksLength === 0) return current;
  return Math.max(0, current - 1);
}

function selectionDown(current: number, tasksLength: number): number {
  if (tasksLength === 0) return current;
  return Math.min(tasksLength - 1, current + 1);
}

function clampSelection(selectedIndex: number, tasksLength: number): number {
  if (tasksLength === 0) return selectedIndex;
  if (selectedIndex >= tasksLength) return tasksLength - 1;
  return selectedIndex;
}

function selectedTask(tasks: TaskInfo[], selectedIndex: number): TaskInfo | null {
  return tasks[selectedIndex] ?? null;
}

// ─── Layout Calculations ────────────────────────────────

function listWidth(width: number): number {
  return Math.min(35, Math.floor(width * 0.3));
}

function outputWidth(width: number): number {
  const lw = listWidth(width);
  return width - lw - 1; // 1 for separator
}

function bodyHeight(height: number): number {
  return height - 2; // header + hint
}

// ─── Task Status Logic ──────────────────────────────────

function taskIcon(status: "running" | "completed" | "failed"): string {
  // G.dot for running, G.dotDim for completed, G.active for failed
  if (status === "running") return "◆";
  if (status === "completed") return "◇";
  return "▸";
}

function taskColor(status: "running" | "completed" | "failed"): string {
  if (status === "running") return "yellow";      // C.primary
  if (status === "completed") return "green";      // C.success
  return "red";                                    // C.error
}

// ─── Output Fetching Error Pattern ──────────────────────

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function getOutputState(
  selected: TaskInfo | null,
  hasExecutor: boolean,
  hasLogPath: boolean,
): "empty" | "no_log" | "fetch" {
  if (!selected || !hasExecutor) return "empty";
  if (!hasLogPath) return "no_log";
  return "fetch";
}

// ─── Tests ──────────────────────────────────────────────

describe("TaskOverlay — selection navigation", () => {
  it("up from 0 stays at 0", () => {
    expect(selectionUp(0, 5)).toBe(0);
  });

  it("up decrements by 1", () => {
    expect(selectionUp(3, 5)).toBe(2);
  });

  it("down increments by 1", () => {
    expect(selectionDown(0, 5)).toBe(1);
  });

  it("down from last entry stays at last", () => {
    expect(selectionDown(4, 5)).toBe(4);
  });

  it("up with empty tasks returns current", () => {
    expect(selectionUp(0, 0)).toBe(0);
  });

  it("down with empty tasks returns current", () => {
    expect(selectionDown(0, 0)).toBe(0);
  });

  it("up from index 1 goes to 0", () => {
    expect(selectionUp(1, 10)).toBe(0);
  });

  it("down with single task stays at 0", () => {
    expect(selectionDown(0, 1)).toBe(0);
  });

  it("sequential down traversal", () => {
    let idx = 0;
    idx = selectionDown(idx, 3); // 1
    idx = selectionDown(idx, 3); // 2
    idx = selectionDown(idx, 3); // 2 (clamped)
    expect(idx).toBe(2);
  });

  it("sequential up traversal", () => {
    let idx = 4;
    idx = selectionUp(idx, 5); // 3
    idx = selectionUp(idx, 5); // 2
    idx = selectionUp(idx, 5); // 1
    idx = selectionUp(idx, 5); // 0
    idx = selectionUp(idx, 5); // 0 (clamped)
    expect(idx).toBe(0);
  });
});

describe("TaskOverlay — selection clamping", () => {
  it("clamps index when tasks shrink", () => {
    expect(clampSelection(5, 3)).toBe(2);
  });

  it("does not clamp valid index", () => {
    expect(clampSelection(1, 3)).toBe(1);
  });

  it("clamps to 0 for single task", () => {
    expect(clampSelection(5, 1)).toBe(0);
  });

  it("returns current for empty tasks (no clamping)", () => {
    expect(clampSelection(3, 0)).toBe(3);
  });

  it("exact boundary: index == length clamps to length - 1", () => {
    expect(clampSelection(3, 3)).toBe(2);
  });

  it("index 0 with tasks stays at 0", () => {
    expect(clampSelection(0, 5)).toBe(0);
  });

  it("index 0 with single task stays at 0", () => {
    expect(clampSelection(0, 1)).toBe(0);
  });
});

describe("TaskOverlay — selected task lookup", () => {
  const tasks: TaskInfo[] = [
    { id: "t1", name: "train", status: "running", machineId: "gpu-0", pid: 1234, startedAt: 1000 },
    { id: "t2", name: "eval", status: "completed", machineId: "gpu-1", pid: 5678, startedAt: 2000 },
    { id: "t3", name: "preprocess", status: "failed", machineId: "cpu-0", startedAt: 3000 },
  ];

  it("returns task at valid index", () => {
    expect(selectedTask(tasks, 0)?.id).toBe("t1");
    expect(selectedTask(tasks, 1)?.id).toBe("t2");
    expect(selectedTask(tasks, 2)?.id).toBe("t3");
  });

  it("returns null for out-of-bounds index", () => {
    expect(selectedTask(tasks, 5)).toBeNull();
    expect(selectedTask(tasks, -1)).toBeNull();
  });

  it("returns null for empty task list", () => {
    expect(selectedTask([], 0)).toBeNull();
  });
});

describe("TaskOverlay — empty task list handling", () => {
  it("empty tasks array has length 0", () => {
    const tasks: TaskInfo[] = [];
    expect(tasks.length).toBe(0);
  });

  it("selected is null with empty tasks", () => {
    expect(selectedTask([], 0)).toBeNull();
  });

  it("navigation is no-op with empty tasks", () => {
    expect(selectionUp(0, 0)).toBe(0);
    expect(selectionDown(0, 0)).toBe(0);
  });
});

describe("TaskOverlay — layout calculations", () => {
  it("list width is 30% of total, max 35", () => {
    expect(listWidth(100)).toBe(30);
    expect(listWidth(120)).toBe(35); // min(35, 36) = 35
    expect(listWidth(200)).toBe(35); // capped at 35
  });

  it("list width for narrow terminals", () => {
    expect(listWidth(50)).toBe(15);
    expect(listWidth(30)).toBe(9);
  });

  it("output width fills remaining space minus separator", () => {
    // width=100: listWidth=30, output=100-30-1=69
    expect(outputWidth(100)).toBe(69);
  });

  it("output width with wide terminal", () => {
    // width=200: listWidth=35, output=200-35-1=164
    expect(outputWidth(200)).toBe(164);
  });

  it("body height subtracts 2 for header and hint", () => {
    expect(bodyHeight(40)).toBe(38);
    expect(bodyHeight(10)).toBe(8);
    expect(bodyHeight(2)).toBe(0);
  });

  it("body height can go negative for very small heights", () => {
    expect(bodyHeight(1)).toBe(-1);
    expect(bodyHeight(0)).toBe(-2);
  });
});

describe("TaskOverlay — task status icons and colors", () => {
  it("running task gets filled dot and primary color", () => {
    expect(taskIcon("running")).toBe("◆");
    expect(taskColor("running")).toBe("yellow");
  });

  it("completed task gets hollow dot and success color", () => {
    expect(taskIcon("completed")).toBe("◇");
    expect(taskColor("completed")).toBe("green");
  });

  it("failed task gets arrow and error color", () => {
    expect(taskIcon("failed")).toBe("▸");
    expect(taskColor("failed")).toBe("red");
  });
});

describe("TaskOverlay — output fetching error handling", () => {
  it("returns empty when no selected task", () => {
    expect(getOutputState(null, true, true)).toBe("empty");
  });

  it("returns empty when no executor", () => {
    const task: TaskInfo = { id: "t1", name: "x", status: "running", machineId: "m1", startedAt: 0 };
    expect(getOutputState(task, false, true)).toBe("empty");
  });

  it("returns no_log when process has no log path", () => {
    const task: TaskInfo = { id: "t1", name: "x", status: "running", machineId: "m1", startedAt: 0 };
    expect(getOutputState(task, true, false)).toBe("no_log");
  });

  it("returns fetch when all conditions met", () => {
    const task: TaskInfo = { id: "t1", name: "x", status: "running", machineId: "m1", startedAt: 0 };
    expect(getOutputState(task, true, true)).toBe("fetch");
  });

  it("formatError extracts Error message", () => {
    expect(formatError(new Error("ssh timeout"))).toBe("ssh timeout");
  });

  it("formatError converts non-Error to string", () => {
    expect(formatError("connection refused")).toBe("connection refused");
    expect(formatError(42)).toBe("42");
    expect(formatError(null)).toBe("null");
  });
});

describe("TaskOverlay — separator height", () => {
  it("separator string has bodyHeight lines", () => {
    const h = bodyHeight(10); // 8
    const separatorLines = Array.from({ length: h }, () => "│").join("\n");
    expect(separatorLines.split("\n").length).toBe(8);
  });

  it("empty separator for 0 body height", () => {
    const h = bodyHeight(2); // 0
    const lines = Array.from({ length: h }, () => "│");
    expect(lines.length).toBe(0);
  });
});
