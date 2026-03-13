import { describe, it, expect, vi, beforeEach } from "vitest";
import { evaluateMetric } from "./metric.js";
import type { MetricCondition, MetricSource } from "./types.js";

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

function metricCondition(
  overrides: Partial<MetricCondition> & { source: MetricSource },
): MetricCondition {
  return {
    kind: "metric",
    machineId: "local",
    field: "loss",
    comparator: "<",
    threshold: 0.5,
    ...overrides,
  };
}

describe("evaluateMetric", () => {
  describe("json_file source", () => {
    it("reads JSON file and extracts field", async () => {
      const responses = new Map([
        [
          "cat",
          {
            stdout: JSON.stringify({ loss: 0.3, accuracy: 0.95 }),
            stderr: "",
            exitCode: 0,
          },
        ],
      ]);
      const pool = mockPool(responses);
      const result = await evaluateMetric(
        metricCondition({
          source: { type: "json_file", path: "/tmp/metrics.json" },
          field: "loss",
          comparator: "<",
          threshold: 0.5,
        }),
        pool,
      );
      expect(result).toBe(true);
    });

    it("handles nested field paths (dot notation)", async () => {
      const responses = new Map([
        [
          "cat",
          {
            stdout: JSON.stringify({ train: { loss: 0.2 } }),
            stderr: "",
            exitCode: 0,
          },
        ],
      ]);
      const pool = mockPool(responses);
      const result = await evaluateMetric(
        metricCondition({
          source: { type: "json_file", path: "/tmp/metrics.json" },
          field: "train.loss",
          comparator: "<",
          threshold: 0.5,
        }),
        pool,
      );
      expect(result).toBe(true);
    });

    it("returns false when field not found", async () => {
      const responses = new Map([
        [
          "cat",
          {
            stdout: JSON.stringify({ accuracy: 0.95 }),
            stderr: "",
            exitCode: 0,
          },
        ],
      ]);
      const pool = mockPool(responses);
      const result = await evaluateMetric(
        metricCondition({
          source: { type: "json_file", path: "/tmp/metrics.json" },
          field: "loss",
          comparator: "<",
          threshold: 0.5,
        }),
        pool,
      );
      expect(result).toBe(false);
    });

    it("returns false when file read fails", async () => {
      const responses = new Map([
        ["cat", { stdout: "", stderr: "No such file", exitCode: 1 }],
      ]);
      const pool = mockPool(responses);
      const result = await evaluateMetric(
        metricCondition({
          source: { type: "json_file", path: "/tmp/missing.json" },
        }),
        pool,
      );
      expect(result).toBe(false);
    });

    it("returns false when JSON parse fails", async () => {
      const responses = new Map([
        ["cat", { stdout: "not valid json{{{", stderr: "", exitCode: 0 }],
      ]);
      const pool = mockPool(responses);
      const result = await evaluateMetric(
        metricCondition({
          source: { type: "json_file", path: "/tmp/bad.json" },
        }),
        pool,
      );
      expect(result).toBe(false);
    });

    it("returns false when extracted field is not a number", async () => {
      const responses = new Map([
        [
          "cat",
          {
            stdout: JSON.stringify({ loss: "not a number" }),
            stderr: "",
            exitCode: 0,
          },
        ],
      ]);
      const pool = mockPool(responses);
      const result = await evaluateMetric(
        metricCondition({
          source: { type: "json_file", path: "/tmp/metrics.json" },
          field: "loss",
          comparator: "<",
          threshold: 0.5,
        }),
        pool,
      );
      expect(result).toBe(false);
    });

    it("handles deeply nested field paths", async () => {
      const responses = new Map([
        [
          "cat",
          {
            stdout: JSON.stringify({ a: { b: { c: { d: 42 } } } }),
            stderr: "",
            exitCode: 0,
          },
        ],
      ]);
      const pool = mockPool(responses);
      const result = await evaluateMetric(
        metricCondition({
          source: { type: "json_file", path: "/tmp/deep.json" },
          field: "a.b.c.d",
          comparator: ">",
          threshold: 10,
        }),
        pool,
      );
      expect(result).toBe(true);
    });

    it("returns false when nested path hits null", async () => {
      const responses = new Map([
        [
          "cat",
          {
            stdout: JSON.stringify({ a: null }),
            stderr: "",
            exitCode: 0,
          },
        ],
      ]);
      const pool = mockPool(responses);
      const result = await evaluateMetric(
        metricCondition({
          source: { type: "json_file", path: "/tmp/null.json" },
          field: "a.b",
          comparator: "<",
          threshold: 1,
        }),
        pool,
      );
      expect(result).toBe(false);
    });
  });

  describe("csv_file source", () => {
    it("reads last line and header to extract field", async () => {
      const pool = mockPool();
      // Single SSH call returns header + last line
      pool.exec.mockResolvedValueOnce({
        stdout: "loss,accuracy,epoch\n0.3,0.95,100\n",
        stderr: "",
        exitCode: 0,
      });

      const result = await evaluateMetric(
        metricCondition({
          source: { type: "csv_file", path: "/tmp/metrics.csv" },
          field: "loss",
          comparator: "<",
          threshold: 0.5,
        }),
        pool,
      );
      expect(result).toBe(true);
    });

    it("returns false when field not in header", async () => {
      const pool = mockPool();
      pool.exec.mockResolvedValueOnce({
        stdout: "accuracy,epoch,lr\n0.3,0.95,100\n",
        stderr: "",
        exitCode: 0,
      });

      const result = await evaluateMetric(
        metricCondition({
          source: { type: "csv_file", path: "/tmp/metrics.csv" },
          field: "loss",
          comparator: "<",
          threshold: 0.5,
        }),
        pool,
      );
      expect(result).toBe(false);
    });

    it("returns false when file read fails", async () => {
      const pool = mockPool();
      pool.exec.mockResolvedValueOnce({
        stdout: "",
        stderr: "No such file",
        exitCode: 1,
      });

      const result = await evaluateMetric(
        metricCondition({
          source: { type: "csv_file", path: "/tmp/missing.csv" },
        }),
        pool,
      );
      expect(result).toBe(false);
    });

    it("returns false when tail output is empty", async () => {
      const pool = mockPool();
      pool.exec.mockResolvedValueOnce({
        stdout: "",
        stderr: "",
        exitCode: 0,
      });

      const result = await evaluateMetric(
        metricCondition({
          source: { type: "csv_file", path: "/tmp/empty.csv" },
        }),
        pool,
      );
      expect(result).toBe(false);
    });
  });

  describe("command source", () => {
    it("executes command and parses numeric output", async () => {
      const pool = mockPool();
      pool.exec.mockResolvedValueOnce({
        stdout: "0.25\n",
        stderr: "",
        exitCode: 0,
      });

      const result = await evaluateMetric(
        metricCondition({
          source: { type: "command", command: "echo 0.25" },
          field: "value",
          comparator: "<",
          threshold: 0.5,
        }),
        pool,
      );
      expect(result).toBe(true);
    });

    it("returns false on non-zero exit code", async () => {
      const pool = mockPool();
      pool.exec.mockResolvedValueOnce({
        stdout: "0.25",
        stderr: "error",
        exitCode: 1,
      });

      const result = await evaluateMetric(
        metricCondition({
          source: { type: "command", command: "failing-cmd" },
        }),
        pool,
      );
      expect(result).toBe(false);
    });

    it("returns false on non-numeric output", async () => {
      const pool = mockPool();
      pool.exec.mockResolvedValueOnce({
        stdout: "not a number\n",
        stderr: "",
        exitCode: 0,
      });

      const result = await evaluateMetric(
        metricCondition({
          source: { type: "command", command: "echo foo" },
        }),
        pool,
      );
      expect(result).toBe(false);
    });

    it("passes command directly to pool.exec", async () => {
      const pool = mockPool();
      pool.exec.mockResolvedValueOnce({
        stdout: "42\n",
        stderr: "",
        exitCode: 0,
      });

      await evaluateMetric(
        metricCondition({
          source: { type: "command", command: "python get_loss.py" },
          comparator: ">",
          threshold: 10,
        }),
        pool,
      );
      expect(pool.exec).toHaveBeenCalledWith("local", "python get_loss.py");
    });
  });

  describe("tensorboard source", () => {
    it("returns false (not supported inline)", async () => {
      const pool = mockPool();
      const result = await evaluateMetric(
        metricCondition({
          source: { type: "tensorboard", logdir: "/tmp/logs" },
        }),
        pool,
      );
      expect(result).toBe(false);
    });
  });

  describe("comparators", () => {
    const jsonSource: MetricSource = {
      type: "json_file",
      path: "/tmp/metrics.json",
    };

    function poolWithValue(value: number) {
      return mockPool(
        new Map([
          [
            "cat",
            {
              stdout: JSON.stringify({ loss: value }),
              stderr: "",
              exitCode: 0,
            },
          ],
        ]),
      );
    }

    it("< returns true when value is less than threshold", async () => {
      const result = await evaluateMetric(
        metricCondition({
          source: jsonSource,
          field: "loss",
          comparator: "<",
          threshold: 0.5,
        }),
        poolWithValue(0.3),
      );
      expect(result).toBe(true);
    });

    it("< returns false when value equals threshold", async () => {
      const result = await evaluateMetric(
        metricCondition({
          source: jsonSource,
          field: "loss",
          comparator: "<",
          threshold: 0.5,
        }),
        poolWithValue(0.5),
      );
      expect(result).toBe(false);
    });

    it("< returns false when value exceeds threshold", async () => {
      const result = await evaluateMetric(
        metricCondition({
          source: jsonSource,
          field: "loss",
          comparator: "<",
          threshold: 0.5,
        }),
        poolWithValue(0.7),
      );
      expect(result).toBe(false);
    });

    it("> returns true when value exceeds threshold", async () => {
      const result = await evaluateMetric(
        metricCondition({
          source: jsonSource,
          field: "loss",
          comparator: ">",
          threshold: 0.5,
        }),
        poolWithValue(0.7),
      );
      expect(result).toBe(true);
    });

    it("> returns false when value equals threshold", async () => {
      const result = await evaluateMetric(
        metricCondition({
          source: jsonSource,
          field: "loss",
          comparator: ">",
          threshold: 0.5,
        }),
        poolWithValue(0.5),
      );
      expect(result).toBe(false);
    });

    it("> returns false when value is less than threshold", async () => {
      const result = await evaluateMetric(
        metricCondition({
          source: jsonSource,
          field: "loss",
          comparator: ">",
          threshold: 0.5,
        }),
        poolWithValue(0.3),
      );
      expect(result).toBe(false);
    });

    it("<= returns true when value is less than threshold", async () => {
      const result = await evaluateMetric(
        metricCondition({
          source: jsonSource,
          field: "loss",
          comparator: "<=",
          threshold: 0.5,
        }),
        poolWithValue(0.3),
      );
      expect(result).toBe(true);
    });

    it("<= returns true when value equals threshold", async () => {
      const result = await evaluateMetric(
        metricCondition({
          source: jsonSource,
          field: "loss",
          comparator: "<=",
          threshold: 0.5,
        }),
        poolWithValue(0.5),
      );
      expect(result).toBe(true);
    });

    it("<= returns false when value exceeds threshold", async () => {
      const result = await evaluateMetric(
        metricCondition({
          source: jsonSource,
          field: "loss",
          comparator: "<=",
          threshold: 0.5,
        }),
        poolWithValue(0.7),
      );
      expect(result).toBe(false);
    });

    it(">= returns true when value exceeds threshold", async () => {
      const result = await evaluateMetric(
        metricCondition({
          source: jsonSource,
          field: "loss",
          comparator: ">=",
          threshold: 0.5,
        }),
        poolWithValue(0.7),
      );
      expect(result).toBe(true);
    });

    it(">= returns true when value equals threshold", async () => {
      const result = await evaluateMetric(
        metricCondition({
          source: jsonSource,
          field: "loss",
          comparator: ">=",
          threshold: 0.5,
        }),
        poolWithValue(0.5),
      );
      expect(result).toBe(true);
    });

    it(">= returns false when value is less than threshold", async () => {
      const result = await evaluateMetric(
        metricCondition({
          source: jsonSource,
          field: "loss",
          comparator: ">=",
          threshold: 0.5,
        }),
        poolWithValue(0.3),
      );
      expect(result).toBe(false);
    });

    it("== returns true when value equals threshold", async () => {
      const result = await evaluateMetric(
        metricCondition({
          source: jsonSource,
          field: "loss",
          comparator: "==",
          threshold: 0.5,
        }),
        poolWithValue(0.5),
      );
      expect(result).toBe(true);
    });

    it("== returns false when value differs from threshold", async () => {
      const result = await evaluateMetric(
        metricCondition({
          source: jsonSource,
          field: "loss",
          comparator: "==",
          threshold: 0.5,
        }),
        poolWithValue(0.3),
      );
      expect(result).toBe(false);
    });

    it("!= returns true when value differs from threshold", async () => {
      const result = await evaluateMetric(
        metricCondition({
          source: jsonSource,
          field: "loss",
          comparator: "!=",
          threshold: 0.5,
        }),
        poolWithValue(0.3),
      );
      expect(result).toBe(true);
    });

    it("!= returns false when value equals threshold", async () => {
      const result = await evaluateMetric(
        metricCondition({
          source: jsonSource,
          field: "loss",
          comparator: "!=",
          threshold: 0.5,
        }),
        poolWithValue(0.5),
      );
      expect(result).toBe(false);
    });
  });

  describe("extractField helper (tested via evaluateMetric)", () => {
    it("extracts top-level field", async () => {
      const pool = mockPool(
        new Map([
          [
            "cat",
            {
              stdout: JSON.stringify({ loss: 0.1 }),
              stderr: "",
              exitCode: 0,
            },
          ],
        ]),
      );
      const result = await evaluateMetric(
        metricCondition({
          source: { type: "json_file", path: "/tmp/m.json" },
          field: "loss",
          comparator: "<",
          threshold: 1,
        }),
        pool,
      );
      expect(result).toBe(true);
    });

    it("extracts nested field", async () => {
      const pool = mockPool(
        new Map([
          [
            "cat",
            {
              stdout: JSON.stringify({ train: { metrics: { loss: 0.1 } } }),
              stderr: "",
              exitCode: 0,
            },
          ],
        ]),
      );
      const result = await evaluateMetric(
        metricCondition({
          source: { type: "json_file", path: "/tmp/m.json" },
          field: "train.metrics.loss",
          comparator: "<",
          threshold: 1,
        }),
        pool,
      );
      expect(result).toBe(true);
    });

    it("returns null for missing field (metric eval returns false)", async () => {
      const pool = mockPool(
        new Map([
          [
            "cat",
            {
              stdout: JSON.stringify({ accuracy: 0.9 }),
              stderr: "",
              exitCode: 0,
            },
          ],
        ]),
      );
      const result = await evaluateMetric(
        metricCondition({
          source: { type: "json_file", path: "/tmp/m.json" },
          field: "nonexistent",
          comparator: "<",
          threshold: 1,
        }),
        pool,
      );
      expect(result).toBe(false);
    });

    it("returns null for non-numeric value (metric eval returns false)", async () => {
      const pool = mockPool(
        new Map([
          [
            "cat",
            {
              stdout: JSON.stringify({ loss: "high" }),
              stderr: "",
              exitCode: 0,
            },
          ],
        ]),
      );
      const result = await evaluateMetric(
        metricCondition({
          source: { type: "json_file", path: "/tmp/m.json" },
          field: "loss",
          comparator: "<",
          threshold: 1,
        }),
        pool,
      );
      expect(result).toBe(false);
    });
  });
});
