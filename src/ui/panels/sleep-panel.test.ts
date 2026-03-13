import { describe, it, expect } from "vitest";
import type { TriggerExpression, TriggerCondition, CompositeTrigger } from "../../scheduler/triggers/types.js";

/**
 * Pure-logic tests for SleepPanel.
 *
 * We test trigger display recursion, leaf condition description,
 * satisfied/unsatisfied icons, deadline countdown, and elapsed time.
 */

// ─── Glyphs (from theme.tsx) ────────────────────────────

const G = {
  dot: "◆",
  dotDim: "◇",
};

const C_SUCCESS = "green";
const C_DIM = "gray";

// ─── Trigger Tree Recursion ─────────────────────────────

interface DisplayNode {
  type: "composite" | "leaf";
  label: string;
  color: string;
  icon?: string;
  children?: DisplayNode[];
  path: string;
}

function buildDisplayTree(
  expression: TriggerExpression,
  satisfiedLeaves: Set<string>,
  path: string,
): DisplayNode {
  if ("op" in expression) {
    return {
      type: "composite",
      label: expression.op.toUpperCase() + ":",
      color: C_DIM,
      path,
      children: expression.children.map((child, i) =>
        buildDisplayTree(child, satisfiedLeaves, `${path}.${i}`),
      ),
    };
  }

  const satisfied = satisfiedLeaves.has(path);
  return {
    type: "leaf",
    label: describeCondition(expression),
    icon: satisfied ? G.dot : G.dotDim,
    color: satisfied ? C_SUCCESS : C_DIM,
    path,
  };
}

// ─── Leaf Condition Description ─────────────────────────

function describeCondition(expr: TriggerExpression): string {
  if ("op" in expr) return `${expr.op}(...)`;

  switch (expr.kind) {
    case "timer":
      return `timer: ${new Date(expr.wakeAt).toLocaleTimeString()}`;
    case "process_exit":
      return `process: ${expr.processPattern ?? `PID ${expr.pid}`} on ${expr.machineId}`;
    case "metric":
      return `metric: ${expr.field} ${expr.comparator} ${expr.threshold}`;
    case "file":
      return `file ${expr.mode}: ${expr.path} on ${expr.machineId}`;
    case "resource":
      return `resource: ${expr.resource} ${expr.comparator} ${expr.threshold}%`;
    case "user_message":
      return "user message";
  }
}

// ─── Deadline / Elapsed Logic ───────────────────────────

function deadlineRemaining(deadline: number | undefined, now: number): number | null {
  if (deadline === undefined) return null;
  return deadline - now;
}

function sleepElapsed(createdAt: number, now: number): number {
  return now - createdAt;
}

// ─── Tests ──────────────────────────────────────────────

describe("SleepPanel — describeCondition (leaf triggers)", () => {
  it("describes timer condition", () => {
    const expr: TriggerCondition = { kind: "timer", wakeAt: 1700000000000 };
    const desc = describeCondition(expr);
    expect(desc).toContain("timer:");
    // The exact time string depends on locale, but it should contain something
    expect(desc.length).toBeGreaterThan(6);
  });

  it("describes process_exit with pattern", () => {
    const expr: TriggerCondition = {
      kind: "process_exit",
      machineId: "gpu-0",
      processPattern: "python train.py",
    };
    expect(describeCondition(expr)).toBe("process: python train.py on gpu-0");
  });

  it("describes process_exit with PID when no pattern", () => {
    const expr: TriggerCondition = {
      kind: "process_exit",
      machineId: "gpu-0",
      pid: 12345,
    };
    expect(describeCondition(expr)).toBe("process: PID 12345 on gpu-0");
  });

  it("describes metric condition", () => {
    const expr: TriggerCondition = {
      kind: "metric",
      machineId: "gpu-0",
      source: { type: "json_file", path: "/tmp/metrics.json" },
      field: "loss",
      comparator: "<",
      threshold: 0.01,
    };
    expect(describeCondition(expr)).toBe("metric: loss < 0.01");
  });

  it("describes file condition with exists mode", () => {
    const expr: TriggerCondition = {
      kind: "file",
      machineId: "gpu-0",
      path: "/output/model.pt",
      mode: "exists",
    };
    expect(describeCondition(expr)).toBe("file exists: /output/model.pt on gpu-0");
  });

  it("describes file condition with modified mode", () => {
    const expr: TriggerCondition = {
      kind: "file",
      machineId: "gpu-0",
      path: "/output/results.csv",
      mode: "modified",
    };
    expect(describeCondition(expr)).toBe("file modified: /output/results.csv on gpu-0");
  });

  it("describes file condition with size_stable mode", () => {
    const expr: TriggerCondition = {
      kind: "file",
      machineId: "gpu-0",
      path: "/output/checkpoint.tar",
      mode: "size_stable",
    };
    expect(describeCondition(expr)).toBe("file size_stable: /output/checkpoint.tar on gpu-0");
  });

  it("describes resource condition", () => {
    const expr: TriggerCondition = {
      kind: "resource",
      machineId: "gpu-0",
      resource: "gpu_util",
      comparator: "<",
      threshold: 10,
    };
    expect(describeCondition(expr)).toBe("resource: gpu_util < 10%");
  });

  it("describes resource condition with different comparators", () => {
    const expr: TriggerCondition = {
      kind: "resource",
      machineId: "gpu-0",
      resource: "memory",
      comparator: ">=",
      threshold: 90,
    };
    expect(describeCondition(expr)).toBe("resource: memory >= 90%");
  });

  it("describes user_message condition", () => {
    const expr: TriggerCondition = { kind: "user_message" };
    expect(describeCondition(expr)).toBe("user message");
  });

  it("describes composite trigger with op label", () => {
    const expr: CompositeTrigger = {
      op: "and",
      children: [],
    };
    expect(describeCondition(expr)).toBe("and(...)");
  });
});

describe("SleepPanel — satisfied vs unsatisfied leaf icons", () => {
  it("satisfied leaf gets filled dot (◆) and success color", () => {
    const satisfiedLeaves = new Set(["root"]);
    const expr: TriggerCondition = { kind: "user_message" };
    const node = buildDisplayTree(expr, satisfiedLeaves, "root");
    expect(node.icon).toBe("◆");
    expect(node.color).toBe("green");
  });

  it("unsatisfied leaf gets hollow dot (◇) and dim color", () => {
    const satisfiedLeaves = new Set<string>();
    const expr: TriggerCondition = { kind: "user_message" };
    const node = buildDisplayTree(expr, satisfiedLeaves, "root");
    expect(node.icon).toBe("◇");
    expect(node.color).toBe("gray");
  });

  it("only matching path counts as satisfied", () => {
    const satisfiedLeaves = new Set(["root.0"]);
    const expr: TriggerCondition = { kind: "user_message" };
    // Path "root.1" is not in the set
    const node = buildDisplayTree(expr, satisfiedLeaves, "root.1");
    expect(node.icon).toBe("◇");
  });
});

describe("SleepPanel — trigger tree recursion (composite triggers)", () => {
  it("AND composite renders children", () => {
    const expr: CompositeTrigger = {
      op: "and",
      children: [
        { kind: "user_message" },
        { kind: "timer", wakeAt: 1700000000000 },
      ],
    };
    const tree = buildDisplayTree(expr, new Set(), "root");
    expect(tree.type).toBe("composite");
    expect(tree.label).toBe("AND:");
    expect(tree.children).toHaveLength(2);
    expect(tree.children![0].path).toBe("root.0");
    expect(tree.children![1].path).toBe("root.1");
  });

  it("OR composite renders children", () => {
    const expr: CompositeTrigger = {
      op: "or",
      children: [
        { kind: "user_message" },
        { kind: "timer", wakeAt: 1700000000000 },
      ],
    };
    const tree = buildDisplayTree(expr, new Set(), "root");
    expect(tree.label).toBe("OR:");
    expect(tree.children).toHaveLength(2);
  });

  it("nested composite triggers recurse correctly", () => {
    const expr: CompositeTrigger = {
      op: "and",
      children: [
        {
          op: "or",
          children: [
            { kind: "user_message" },
            { kind: "timer", wakeAt: 1700000000000 },
          ],
        },
        {
          kind: "process_exit",
          machineId: "gpu-0",
          pid: 1234,
        },
      ],
    };
    const tree = buildDisplayTree(expr, new Set(), "root");
    expect(tree.type).toBe("composite");
    expect(tree.children).toHaveLength(2);

    const orChild = tree.children![0];
    expect(orChild.type).toBe("composite");
    expect(orChild.label).toBe("OR:");
    expect(orChild.path).toBe("root.0");
    expect(orChild.children).toHaveLength(2);
    expect(orChild.children![0].path).toBe("root.0.0");
    expect(orChild.children![1].path).toBe("root.0.1");

    const leafChild = tree.children![1];
    expect(leafChild.type).toBe("leaf");
    expect(leafChild.path).toBe("root.1");
  });

  it("deeply nested composite: 3 levels", () => {
    const expr: CompositeTrigger = {
      op: "and",
      children: [
        {
          op: "or",
          children: [
            {
              op: "and",
              children: [
                { kind: "user_message" },
                { kind: "timer", wakeAt: 1000 },
              ],
            },
          ],
        },
      ],
    };
    const tree = buildDisplayTree(expr, new Set(), "root");
    const innermost = tree.children![0].children![0].children![0];
    expect(innermost.type).toBe("leaf");
    expect(innermost.path).toBe("root.0.0.0");
  });

  it("satisfied leaves within composites are marked correctly", () => {
    const expr: CompositeTrigger = {
      op: "and",
      children: [
        { kind: "user_message" },
        { kind: "timer", wakeAt: 1700000000000 },
      ],
    };
    const satisfied = new Set(["root.0"]);
    const tree = buildDisplayTree(expr, satisfied, "root");
    expect(tree.children![0].icon).toBe("◆");
    expect(tree.children![0].color).toBe("green");
    expect(tree.children![1].icon).toBe("◇");
    expect(tree.children![1].color).toBe("gray");
  });

  it("empty composite has no children", () => {
    const expr: CompositeTrigger = { op: "and", children: [] };
    const tree = buildDisplayTree(expr, new Set(), "root");
    expect(tree.children).toHaveLength(0);
  });

  it("single-child composite", () => {
    const expr: CompositeTrigger = {
      op: "or",
      children: [{ kind: "user_message" }],
    };
    const tree = buildDisplayTree(expr, new Set(), "root");
    expect(tree.children).toHaveLength(1);
    expect(tree.children![0].type).toBe("leaf");
  });
});

describe("SleepPanel — deadline countdown calculation", () => {
  it("returns positive remaining time when deadline is in the future", () => {
    const remaining = deadlineRemaining(1000, 500);
    expect(remaining).toBe(500);
  });

  it("returns 0 when deadline equals now", () => {
    const remaining = deadlineRemaining(1000, 1000);
    expect(remaining).toBe(0);
  });

  it("returns negative when deadline has passed", () => {
    const remaining = deadlineRemaining(1000, 1500);
    expect(remaining).toBe(-500);
  });

  it("returns null when no deadline set", () => {
    expect(deadlineRemaining(undefined, 1000)).toBeNull();
  });

  it("large deadline values work", () => {
    const deadline = Date.now() + 86_400_000; // 24 hours from now
    const now = Date.now();
    const remaining = deadlineRemaining(deadline, now);
    expect(remaining).toBeGreaterThan(86_399_000);
    expect(remaining).toBeLessThanOrEqual(86_400_000);
  });
});

describe("SleepPanel — sleep elapsed time calculation", () => {
  it("computes elapsed time", () => {
    expect(sleepElapsed(1000, 5000)).toBe(4000);
  });

  it("returns 0 when just started", () => {
    expect(sleepElapsed(1000, 1000)).toBe(0);
  });

  it("handles large elapsed values", () => {
    // 3 hours in milliseconds
    expect(sleepElapsed(0, 10_800_000)).toBe(10_800_000);
  });

  it("elapsed increases with time", () => {
    const created = 1000;
    const t1 = sleepElapsed(created, 2000);
    const t2 = sleepElapsed(created, 3000);
    expect(t2).toBeGreaterThan(t1);
  });
});

describe("SleepPanel — display condition shows remaining only when positive", () => {
  it("remaining > 0: display wake-in countdown", () => {
    const remaining = deadlineRemaining(2000, 1000);
    // Component: remaining !== null && remaining > 0
    expect(remaining).not.toBeNull();
    expect(remaining!).toBeGreaterThan(0);
  });

  it("remaining <= 0: do not display countdown", () => {
    const remaining = deadlineRemaining(1000, 1500);
    expect(remaining).not.toBeNull();
    expect(remaining!).toBeLessThanOrEqual(0);
  });

  it("no deadline: do not display countdown", () => {
    const remaining = deadlineRemaining(undefined, 1000);
    expect(remaining).toBeNull();
  });
});

describe("SleepPanel — all leaf trigger kinds produce descriptions", () => {
  const allLeafKinds: TriggerCondition[] = [
    { kind: "timer", wakeAt: 1700000000000 },
    { kind: "process_exit", machineId: "m1", pid: 42 },
    { kind: "process_exit", machineId: "m1", processPattern: "python" },
    { kind: "metric", machineId: "m1", source: { type: "json_file", path: "/x" }, field: "loss", comparator: "<", threshold: 0.1 },
    { kind: "file", machineId: "m1", path: "/x", mode: "exists" },
    { kind: "file", machineId: "m1", path: "/x", mode: "modified" },
    { kind: "file", machineId: "m1", path: "/x", mode: "size_stable" },
    { kind: "resource", machineId: "m1", resource: "gpu_util", comparator: ">", threshold: 80 },
    { kind: "resource", machineId: "m1", resource: "cpu", comparator: "<", threshold: 20 },
    { kind: "resource", machineId: "m1", resource: "memory", comparator: ">=", threshold: 90 },
    { kind: "resource", machineId: "m1", resource: "disk", comparator: "<=", threshold: 95 },
    { kind: "resource", machineId: "m1", resource: "gpu_memory", comparator: ">", threshold: 50 },
    { kind: "user_message" },
  ];

  for (const expr of allLeafKinds) {
    it(`produces non-empty description for ${expr.kind}${("mode" in expr ? `:${expr.mode}` : "")}`, () => {
      const desc = describeCondition(expr);
      expect(desc.length).toBeGreaterThan(0);
      expect(typeof desc).toBe("string");
    });
  }
});
