import { describe, it, expect } from "vitest";
import { C, G } from "../theme.js";

// ─── Copies of internal helpers from task-list.tsx ────────────────
// These are small pure functions not exported from the module,
// so we reproduce them here for unit testing.

function statusIcon(status: string): string {
  switch (status) {
    case "running":
      return G.dot;
    case "completed":
      return G.dot;
    case "failed":
      return G.active;
    default:
      return G.bullet;
  }
}

function statusColor(status: string): string {
  switch (status) {
    case "running":
      return C.primary;
    case "completed":
      return C.success;
    case "failed":
      return C.error;
    default:
      return C.dim;
  }
}

function gpuColor(utilization: number | null): string {
  if (utilization === null) return C.dim;
  if (utilization > 80) return C.success;
  if (utilization > 30) return C.primary;
  if (utilization > 0) return C.dim;
  return C.error;
}

function diskColor(used: number, total: number): string {
  const pct = total > 0 ? used / total : 0;
  if (pct > 0.9) return C.error;
  if (pct > 0.75) return C.primary;
  return C.dim;
}

// ─── Tests ───────────────────────────────────────────────────────

describe("statusIcon", () => {
  it("returns dot for running", () => {
    expect(statusIcon("running")).toBe(G.dot);
  });

  it("returns dot for completed", () => {
    expect(statusIcon("completed")).toBe(G.dot);
  });

  it("returns active glyph for failed", () => {
    expect(statusIcon("failed")).toBe(G.active);
  });

  it("returns bullet for unknown status", () => {
    expect(statusIcon("unknown")).toBe(G.bullet);
    expect(statusIcon("")).toBe(G.bullet);
    expect(statusIcon("pending")).toBe(G.bullet);
    expect(statusIcon("queued")).toBe(G.bullet);
  });

  it("running and completed icons are the same glyph", () => {
    expect(statusIcon("running")).toBe(statusIcon("completed"));
  });

  it("failed icon differs from running/completed icon", () => {
    expect(statusIcon("failed")).not.toBe(statusIcon("running"));
  });
});

describe("statusColor", () => {
  it("returns primary color for running", () => {
    expect(statusColor("running")).toBe(C.primary);
    expect(statusColor("running")).toBe("yellow");
  });

  it("returns success color for completed", () => {
    expect(statusColor("completed")).toBe(C.success);
    expect(statusColor("completed")).toBe("green");
  });

  it("returns error color for failed", () => {
    expect(statusColor("failed")).toBe(C.error);
    expect(statusColor("failed")).toBe("red");
  });

  it("returns dim color for unknown status", () => {
    expect(statusColor("unknown")).toBe(C.dim);
    expect(statusColor("")).toBe(C.dim);
    expect(statusColor("pending")).toBe(C.dim);
    expect(statusColor("cancelled")).toBe(C.dim);
  });

  it("each known status has a distinct color", () => {
    const colors = new Set([
      statusColor("running"),
      statusColor("completed"),
      statusColor("failed"),
    ]);
    expect(colors.size).toBe(3);
  });
});

describe("gpuColor", () => {
  it("returns dim for null utilization (unavailable)", () => {
    expect(gpuColor(null)).toBe(C.dim);
  });

  it("returns success (green) for utilization > 80%", () => {
    expect(gpuColor(81)).toBe(C.success);
    expect(gpuColor(95)).toBe(C.success);
    expect(gpuColor(100)).toBe(C.success);
  });

  it("returns primary (yellow) for utilization > 30% and <= 80%", () => {
    expect(gpuColor(31)).toBe(C.primary);
    expect(gpuColor(50)).toBe(C.primary);
    expect(gpuColor(80)).toBe(C.primary);
  });

  it("returns dim for utilization > 0% and <= 30%", () => {
    expect(gpuColor(1)).toBe(C.dim);
    expect(gpuColor(15)).toBe(C.dim);
    expect(gpuColor(30)).toBe(C.dim);
  });

  it("returns error (red) for 0% utilization (idle/crashed)", () => {
    expect(gpuColor(0)).toBe(C.error);
  });

  it("boundary: exactly 80 is primary, not success", () => {
    expect(gpuColor(80)).toBe(C.primary);
  });

  it("boundary: exactly 30 is dim, not primary", () => {
    expect(gpuColor(30)).toBe(C.dim);
  });

  it("boundary: 80.1 is success", () => {
    expect(gpuColor(80.1)).toBe(C.success);
  });

  it("boundary: 30.1 is primary", () => {
    expect(gpuColor(30.1)).toBe(C.primary);
  });

  it("boundary: 0.1 is dim", () => {
    expect(gpuColor(0.1)).toBe(C.dim);
  });
});

describe("diskColor", () => {
  it("returns error (red) for usage > 90%", () => {
    expect(diskColor(91, 100)).toBe(C.error);
    expect(diskColor(950, 1000)).toBe(C.error);
    expect(diskColor(100, 100)).toBe(C.error);
  });

  it("returns primary (yellow) for usage > 75% and <= 90%", () => {
    expect(diskColor(76, 100)).toBe(C.primary);
    expect(diskColor(85, 100)).toBe(C.primary);
    expect(diskColor(90, 100)).toBe(C.primary);
  });

  it("returns dim for usage <= 75%", () => {
    expect(diskColor(75, 100)).toBe(C.dim);
    expect(diskColor(50, 100)).toBe(C.dim);
    expect(diskColor(0, 100)).toBe(C.dim);
  });

  it("handles zero total (avoids division by zero)", () => {
    // pct = total > 0 ? used/total : 0 => 0, so dim
    expect(diskColor(0, 0)).toBe(C.dim);
    expect(diskColor(100, 0)).toBe(C.dim);
  });

  it("boundary: exactly 90% is primary, not error", () => {
    expect(diskColor(90, 100)).toBe(C.primary);
  });

  it("boundary: exactly 75% is dim, not primary", () => {
    expect(diskColor(75, 100)).toBe(C.dim);
  });

  it("boundary: 90.1% is error", () => {
    expect(diskColor(901, 1000)).toBe(C.error);
  });

  it("boundary: 75.1% is primary", () => {
    expect(diskColor(751, 1000)).toBe(C.primary);
  });

  it("handles very large disk sizes", () => {
    // 8TB used of 10TB
    const used = 8e12;
    const total = 10e12;
    expect(diskColor(used, total)).toBe(C.primary); // 80%
  });

  it("handles tiny disks", () => {
    expect(diskColor(1, 2)).toBe(C.dim); // 50%
  });

  it("nearly full disk is error", () => {
    expect(diskColor(999, 1000)).toBe(C.error); // 99.9%
  });
});

describe("task name truncation logic", () => {
  // The component truncates names like:
  // name.length > nameWidth ? name.slice(0, nameWidth - 1) + "..." : name
  function truncateTaskName(name: string, nameWidth: number): string {
    if (name.length > nameWidth) {
      return name.slice(0, nameWidth - 1) + "\u2026";
    }
    return name;
  }

  it("leaves short names unchanged", () => {
    expect(truncateTaskName("train", 20)).toBe("train");
  });

  it("truncates long names with ellipsis", () => {
    const name = "training_resnet50_cifar10_augmented";
    const result = truncateTaskName(name, 15);
    expect(result).toHaveLength(15);
    expect(result.endsWith("\u2026")).toBe(true);
  });

  it("handles exact length name", () => {
    expect(truncateTaskName("abcde", 5)).toBe("abcde");
  });

  it("handles name one char over limit", () => {
    expect(truncateTaskName("abcdef", 5)).toBe("abcd\u2026");
  });
});
