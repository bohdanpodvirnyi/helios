import { describe, it, expect, vi, beforeEach } from "vitest";
import { evaluateResource } from "./resource.js";
import type { ResourceCondition } from "./types.js";

function mockPool(
  responses?: Map<string, { stdout: string; stderr: string; exitCode: number }>,
): any {
  return {
    exec: vi.fn(async (_machineId: string, command: string) => {
      if (responses) {
        for (const [key, value] of responses) {
          if (command.includes(key)) return value;
        }
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    }),
    isProcessRunning: vi.fn().mockResolvedValue(false),
    getMachineIds: vi.fn().mockReturnValue(["local"]),
  };
}

function resourceCondition(
  overrides: Partial<ResourceCondition> = {},
): ResourceCondition {
  return {
    kind: "resource",
    machineId: "local",
    resource: "gpu_util",
    comparator: "<",
    threshold: 50,
    ...overrides,
  };
}

describe("evaluateResource", () => {
  describe("gpu_util", () => {
    it("parses nvidia-smi output", async () => {
      const responses = new Map([
        [
          "nvidia-smi",
          { stdout: "25\n", stderr: "", exitCode: 0 },
        ],
      ]);
      const pool = mockPool(responses);
      const result = await evaluateResource(
        resourceCondition({ resource: "gpu_util", comparator: "<", threshold: 50 }),
        pool,
      );
      expect(result).toBe(true);
    });

    it("uses correct gpu index", async () => {
      const pool = mockPool(
        new Map([
          ["nvidia-smi", { stdout: "75\n", stderr: "", exitCode: 0 }],
        ]),
      );
      await evaluateResource(
        resourceCondition({ resource: "gpu_util", gpuIndex: 2 }),
        pool,
      );
      const command = pool.exec.mock.calls[0][1] as string;
      expect(command).toContain("-i 2");
    });

    it("defaults to gpu 0", async () => {
      const pool = mockPool(
        new Map([
          ["nvidia-smi", { stdout: "75\n", stderr: "", exitCode: 0 }],
        ]),
      );
      await evaluateResource(
        resourceCondition({ resource: "gpu_util" }),
        pool,
      );
      const command = pool.exec.mock.calls[0][1] as string;
      expect(command).toContain("-i 0");
    });

    it("returns false on command failure", async () => {
      const responses = new Map([
        [
          "nvidia-smi",
          { stdout: "", stderr: "not found", exitCode: 127 },
        ],
      ]);
      const pool = mockPool(responses);
      const result = await evaluateResource(
        resourceCondition({ resource: "gpu_util", comparator: "<", threshold: 50 }),
        pool,
      );
      expect(result).toBe(false);
    });
  });

  describe("gpu_memory", () => {
    it("calculates percentage from used/total", async () => {
      const responses = new Map([
        [
          "nvidia-smi",
          { stdout: "4000, 8000\n", stderr: "", exitCode: 0 },
        ],
      ]);
      const pool = mockPool(responses);
      // 4000/8000 = 50%
      const result = await evaluateResource(
        resourceCondition({
          resource: "gpu_memory",
          comparator: "<=",
          threshold: 50,
        }),
        pool,
      );
      expect(result).toBe(true);
    });

    it("returns true when memory usage exceeds threshold", async () => {
      const responses = new Map([
        [
          "nvidia-smi",
          { stdout: "7000, 8000\n", stderr: "", exitCode: 0 },
        ],
      ]);
      const pool = mockPool(responses);
      // 7000/8000 = 87.5%
      const result = await evaluateResource(
        resourceCondition({
          resource: "gpu_memory",
          comparator: ">",
          threshold: 80,
        }),
        pool,
      );
      expect(result).toBe(true);
    });

    it("handles command failure", async () => {
      const responses = new Map([
        ["nvidia-smi", { stdout: "", stderr: "error", exitCode: 1 }],
      ]);
      const pool = mockPool(responses);
      const result = await evaluateResource(
        resourceCondition({ resource: "gpu_memory", comparator: "<", threshold: 50 }),
        pool,
      );
      expect(result).toBe(false);
    });

    it("uses correct gpu index for memory", async () => {
      const pool = mockPool(
        new Map([
          ["nvidia-smi", { stdout: "2000, 8000\n", stderr: "", exitCode: 0 }],
        ]),
      );
      await evaluateResource(
        resourceCondition({ resource: "gpu_memory", gpuIndex: 3 }),
        pool,
      );
      const command = pool.exec.mock.calls[0][1] as string;
      expect(command).toContain("-i 3");
    });
  });

  describe("cpu", () => {
    it("parses top output", async () => {
      const responses = new Map([
        ["top", { stdout: "45.2\n", stderr: "", exitCode: 0 }],
      ]);
      const pool = mockPool(responses);
      const result = await evaluateResource(
        resourceCondition({ resource: "cpu", comparator: "<", threshold: 50 }),
        pool,
      );
      expect(result).toBe(true);
    });

    it("handles failure", async () => {
      const responses = new Map([
        ["top", { stdout: "", stderr: "error", exitCode: 1 }],
      ]);
      const pool = mockPool(responses);
      const result = await evaluateResource(
        resourceCondition({ resource: "cpu", comparator: "<", threshold: 50 }),
        pool,
      );
      expect(result).toBe(false);
    });

    it("returns false when cpu exceeds threshold", async () => {
      const responses = new Map([
        ["top", { stdout: "85.0\n", stderr: "", exitCode: 0 }],
      ]);
      const pool = mockPool(responses);
      const result = await evaluateResource(
        resourceCondition({ resource: "cpu", comparator: "<", threshold: 50 }),
        pool,
      );
      expect(result).toBe(false);
    });
  });

  describe("memory", () => {
    it("parses free output", async () => {
      const responses = new Map([
        ["free", { stdout: "62.5\n", stderr: "", exitCode: 0 }],
      ]);
      const pool = mockPool(responses);
      const result = await evaluateResource(
        resourceCondition({
          resource: "memory",
          comparator: "<",
          threshold: 80,
        }),
        pool,
      );
      expect(result).toBe(true);
    });

    it("handles failure", async () => {
      const responses = new Map([
        ["free", { stdout: "", stderr: "error", exitCode: 1 }],
      ]);
      const pool = mockPool(responses);
      const result = await evaluateResource(
        resourceCondition({ resource: "memory", comparator: "<", threshold: 80 }),
        pool,
      );
      expect(result).toBe(false);
    });
  });

  describe("disk", () => {
    it("parses df output", async () => {
      const responses = new Map([
        ["df", { stdout: "42\n", stderr: "", exitCode: 0 }],
      ]);
      const pool = mockPool(responses);
      const result = await evaluateResource(
        resourceCondition({ resource: "disk", comparator: "<", threshold: 80 }),
        pool,
      );
      expect(result).toBe(true);
    });

    it("handles failure", async () => {
      const responses = new Map([
        ["df", { stdout: "", stderr: "error", exitCode: 1 }],
      ]);
      const pool = mockPool(responses);
      const result = await evaluateResource(
        resourceCondition({ resource: "disk", comparator: "<", threshold: 80 }),
        pool,
      );
      expect(result).toBe(false);
    });
  });

  describe("all comparators with resource values", () => {
    function gpuPool(value: number) {
      return mockPool(
        new Map([
          ["nvidia-smi", { stdout: `${value}\n`, stderr: "", exitCode: 0 }],
        ]),
      );
    }

    it("< threshold returns true when value is below", async () => {
      const result = await evaluateResource(
        resourceCondition({ resource: "gpu_util", comparator: "<", threshold: 50 }),
        gpuPool(30),
      );
      expect(result).toBe(true);
    });

    it("< threshold returns false when value is above", async () => {
      const result = await evaluateResource(
        resourceCondition({ resource: "gpu_util", comparator: "<", threshold: 50 }),
        gpuPool(70),
      );
      expect(result).toBe(false);
    });

    it("> threshold returns true when value is above", async () => {
      const result = await evaluateResource(
        resourceCondition({ resource: "gpu_util", comparator: ">", threshold: 50 }),
        gpuPool(70),
      );
      expect(result).toBe(true);
    });

    it("> threshold returns false when value is below", async () => {
      const result = await evaluateResource(
        resourceCondition({ resource: "gpu_util", comparator: ">", threshold: 50 }),
        gpuPool(30),
      );
      expect(result).toBe(false);
    });

    it("<= threshold returns true when value equals threshold", async () => {
      const result = await evaluateResource(
        resourceCondition({ resource: "gpu_util", comparator: "<=", threshold: 50 }),
        gpuPool(50),
      );
      expect(result).toBe(true);
    });

    it("<= threshold returns true when value is below", async () => {
      const result = await evaluateResource(
        resourceCondition({ resource: "gpu_util", comparator: "<=", threshold: 50 }),
        gpuPool(30),
      );
      expect(result).toBe(true);
    });

    it(">= threshold returns true when value equals threshold", async () => {
      const result = await evaluateResource(
        resourceCondition({ resource: "gpu_util", comparator: ">=", threshold: 50 }),
        gpuPool(50),
      );
      expect(result).toBe(true);
    });

    it(">= threshold returns true when value is above", async () => {
      const result = await evaluateResource(
        resourceCondition({ resource: "gpu_util", comparator: ">=", threshold: 50 }),
        gpuPool(70),
      );
      expect(result).toBe(true);
    });
  });
});
