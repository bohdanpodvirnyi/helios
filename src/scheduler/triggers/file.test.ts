import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { evaluateFile } from "./file.js";
import type { FileCondition } from "./types.js";

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

function fileCondition(
  overrides: Partial<FileCondition> = {},
): FileCondition {
  return {
    kind: "file",
    machineId: "local",
    path: "/tmp/output.txt",
    mode: "exists",
    ...overrides,
  };
}

describe("evaluateFile", () => {
  describe("exists mode", () => {
    it("returns true when file exists", async () => {
      const responses = new Map([
        ["test -e", { stdout: "exists\n", stderr: "", exitCode: 0 }],
      ]);
      const pool = mockPool(responses);
      const result = await evaluateFile(
        fileCondition({ mode: "exists" }),
        pool,
      );
      expect(result).toBe(true);
    });

    it("returns false when file does not exist", async () => {
      const responses = new Map([
        ["test -e", { stdout: "missing\n", stderr: "", exitCode: 0 }],
      ]);
      const pool = mockPool(responses);
      const result = await evaluateFile(
        fileCondition({ mode: "exists" }),
        pool,
      );
      expect(result).toBe(false);
    });

    it("uses shell-quoted path", async () => {
      const pool = mockPool();
      await evaluateFile(
        fileCondition({ mode: "exists", path: "/tmp/my file.txt" }),
        pool,
      );
      const command = pool.exec.mock.calls[0][1] as string;
      expect(command).toContain("'/tmp/my file.txt'");
    });

    it("returns false when stdout is empty", async () => {
      const responses = new Map([
        ["test -e", { stdout: "", stderr: "", exitCode: 0 }],
      ]);
      const pool = mockPool(responses);
      const result = await evaluateFile(
        fileCondition({ mode: "exists" }),
        pool,
      );
      expect(result).toBe(false);
    });
  });

  describe("modified mode", () => {
    it("returns false on first evaluation (captures baseline)", async () => {
      const responses = new Map([
        ["stat", { stdout: "1700000000\n", stderr: "", exitCode: 0 }],
      ]);
      const pool = mockPool(responses);
      const cond = fileCondition({
        mode: "modified",
        path: "/tmp/modified-first-eval.txt",
      });
      const result = await evaluateFile(cond, pool);
      expect(result).toBe(false);
      // Baseline should be captured
      expect(cond.baselineMtime).toBe(1700000000);
    });

    it("returns false when mtime unchanged", async () => {
      const responses = new Map([
        ["stat", { stdout: "1700000000\n", stderr: "", exitCode: 0 }],
      ]);
      const pool = mockPool(responses);
      const cond = fileCondition({
        mode: "modified",
        path: "/tmp/modified-unchanged.txt",
        baselineMtime: 1700000000,
      });
      const result = await evaluateFile(cond, pool);
      expect(result).toBe(false);
    });

    it("returns true when mtime increased", async () => {
      const responses = new Map([
        ["stat", { stdout: "1700000100\n", stderr: "", exitCode: 0 }],
      ]);
      const pool = mockPool(responses);
      const cond = fileCondition({
        mode: "modified",
        path: "/tmp/modified-changed.txt",
        baselineMtime: 1700000000,
      });
      const result = await evaluateFile(cond, pool);
      expect(result).toBe(true);
    });

    it("returns false when mtime decreased (unusual but possible)", async () => {
      const responses = new Map([
        ["stat", { stdout: "1699999900\n", stderr: "", exitCode: 0 }],
      ]);
      const pool = mockPool(responses);
      const cond = fileCondition({
        mode: "modified",
        path: "/tmp/modified-decreased.txt",
        baselineMtime: 1700000000,
      });
      const result = await evaluateFile(cond, pool);
      expect(result).toBe(false);
    });

    it("handles stat failure (exit code != 0)", async () => {
      const responses = new Map([
        ["stat", { stdout: "", stderr: "No such file", exitCode: 1 }],
      ]);
      const pool = mockPool(responses);
      const result = await evaluateFile(
        fileCondition({ mode: "modified", path: "/tmp/modified-fail.txt" }),
        pool,
      );
      expect(result).toBe(false);
    });

    it("handles non-numeric stat output", async () => {
      const responses = new Map([
        ["stat", { stdout: "not-a-number\n", stderr: "", exitCode: 0 }],
      ]);
      const pool = mockPool(responses);
      const result = await evaluateFile(
        fileCondition({
          mode: "modified",
          path: "/tmp/modified-nan.txt",
        }),
        pool,
      );
      expect(result).toBe(false);
    });
  });

  describe("size_stable mode", () => {
    it("returns false on first check (records baseline)", async () => {
      const responses = new Map([
        ["stat", { stdout: "1024\n", stderr: "", exitCode: 0 }],
      ]);
      const pool = mockPool(responses);
      const result = await evaluateFile(
        fileCondition({
          mode: "size_stable",
          path: "/tmp/size-stable-first-" + Math.random() + ".txt",
        }),
        pool,
      );
      expect(result).toBe(false);
    });

    it("returns false when size changes", async () => {
      const uniquePath = "/tmp/size-change-" + Math.random() + ".txt";

      // First call: record baseline
      const pool1 = mockPool(
        new Map([
          ["stat", { stdout: "1024\n", stderr: "", exitCode: 0 }],
        ]),
      );
      await evaluateFile(
        fileCondition({ mode: "size_stable", path: uniquePath }),
        pool1,
      );

      // Second call: size changed
      const pool2 = mockPool(
        new Map([
          ["stat", { stdout: "2048\n", stderr: "", exitCode: 0 }],
        ]),
      );
      const result = await evaluateFile(
        fileCondition({ mode: "size_stable", path: uniquePath }),
        pool2,
      );
      expect(result).toBe(false);
    });

    it("returns true when size stable for >= stabilityWindowSec", async () => {
      const uniquePath = "/tmp/size-stable-window-" + Math.random() + ".txt";
      const responses = new Map([
        ["stat", { stdout: "1024\n", stderr: "", exitCode: 0 }],
      ]);

      // First call: record baseline
      const pool1 = mockPool(responses);
      await evaluateFile(
        fileCondition({
          mode: "size_stable",
          path: uniquePath,
          stabilityWindowSec: 5,
        }),
        pool1,
      );

      // Mock Date.now to be 10 seconds later
      const originalNow = Date.now;
      vi.spyOn(Date, "now").mockReturnValue(originalNow() + 10_000);

      // Second call: same size, enough time passed
      const pool2 = mockPool(responses);
      const result = await evaluateFile(
        fileCondition({
          mode: "size_stable",
          path: uniquePath,
          stabilityWindowSec: 5,
        }),
        pool2,
      );
      expect(result).toBe(true);

      vi.restoreAllMocks();
    });

    it("uses default 60s stability window", async () => {
      const uniquePath = "/tmp/size-stable-default-" + Math.random() + ".txt";
      const responses = new Map([
        ["stat", { stdout: "512\n", stderr: "", exitCode: 0 }],
      ]);

      // First call
      const pool1 = mockPool(responses);
      await evaluateFile(
        fileCondition({ mode: "size_stable", path: uniquePath }),
        pool1,
      );

      // 30 seconds later - not enough
      const originalNow = Date.now;
      vi.spyOn(Date, "now").mockReturnValue(originalNow() + 30_000);
      const pool2 = mockPool(responses);
      const result = await evaluateFile(
        fileCondition({ mode: "size_stable", path: uniquePath }),
        pool2,
      );
      expect(result).toBe(false);

      vi.restoreAllMocks();
    });

    it("respects custom stabilityWindowSec", async () => {
      const uniquePath = "/tmp/size-stable-custom-" + Math.random() + ".txt";
      const responses = new Map([
        ["stat", { stdout: "256\n", stderr: "", exitCode: 0 }],
      ]);

      // First call
      const pool1 = mockPool(responses);
      await evaluateFile(
        fileCondition({
          mode: "size_stable",
          path: uniquePath,
          stabilityWindowSec: 2,
        }),
        pool1,
      );

      // 3 seconds later - enough for custom 2s window
      const originalNow = Date.now;
      vi.spyOn(Date, "now").mockReturnValue(originalNow() + 3_000);
      const pool2 = mockPool(responses);
      const result = await evaluateFile(
        fileCondition({
          mode: "size_stable",
          path: uniquePath,
          stabilityWindowSec: 2,
        }),
        pool2,
      );
      expect(result).toBe(true);

      vi.restoreAllMocks();
    });

    it("handles stat failure", async () => {
      const responses = new Map([
        ["stat", { stdout: "", stderr: "error", exitCode: 1 }],
      ]);
      const pool = mockPool(responses);
      const result = await evaluateFile(
        fileCondition({
          mode: "size_stable",
          path: "/tmp/size-stable-fail-" + Math.random() + ".txt",
        }),
        pool,
      );
      expect(result).toBe(false);
    });

    it("resets since time when size changes", async () => {
      const uniquePath = "/tmp/size-reset-" + Math.random() + ".txt";

      // Record baseline with size 100
      const pool1 = mockPool(
        new Map([["stat", { stdout: "100\n", stderr: "", exitCode: 0 }]]),
      );
      await evaluateFile(
        fileCondition({
          mode: "size_stable",
          path: uniquePath,
          stabilityWindowSec: 5,
        }),
        pool1,
      );

      // Size changes to 200 - should reset the timer
      const pool2 = mockPool(
        new Map([["stat", { stdout: "200\n", stderr: "", exitCode: 0 }]]),
      );
      await evaluateFile(
        fileCondition({
          mode: "size_stable",
          path: uniquePath,
          stabilityWindowSec: 5,
        }),
        pool2,
      );

      // Even if enough time has passed since initial record, timer was reset
      const originalNow = Date.now;
      vi.spyOn(Date, "now").mockReturnValue(originalNow() + 3_000);
      const pool3 = mockPool(
        new Map([["stat", { stdout: "200\n", stderr: "", exitCode: 0 }]]),
      );
      const result = await evaluateFile(
        fileCondition({
          mode: "size_stable",
          path: uniquePath,
          stabilityWindowSec: 5,
        }),
        pool3,
      );
      // 3s since reset, window is 5s, so still not stable
      expect(result).toBe(false);

      vi.restoreAllMocks();
    });

    it("handles non-numeric stat output for size", async () => {
      // When parseInt returns NaN, the comparison prev.size !== size will be true
      // (NaN !== NaN), so it will always reset and return false
      const responses = new Map([
        ["stat", { stdout: "abc\n", stderr: "", exitCode: 0 }],
      ]);
      const pool = mockPool(responses);
      const result = await evaluateFile(
        fileCondition({
          mode: "size_stable",
          path: "/tmp/size-nan-" + Math.random() + ".txt",
        }),
        pool,
      );
      expect(result).toBe(false);
    });
  });

  describe("path quoting", () => {
    it("quotes paths with spaces in exists mode", async () => {
      const pool = mockPool();
      await evaluateFile(
        fileCondition({ mode: "exists", path: "/tmp/path with spaces/file.txt" }),
        pool,
      );
      const command = pool.exec.mock.calls[0][1] as string;
      expect(command).toContain("'/tmp/path with spaces/file.txt'");
    });

    it("quotes paths with single quotes in modified mode", async () => {
      const pool = mockPool(
        new Map([["stat", { stdout: "1700000000\n", stderr: "", exitCode: 0 }]]),
      );
      await evaluateFile(
        fileCondition({ mode: "modified", path: "/tmp/it's a file.txt" }),
        pool,
      );
      const command = pool.exec.mock.calls[0][1] as string;
      expect(command).toContain("'/tmp/it'\\''s a file.txt'");
    });
  });
});
