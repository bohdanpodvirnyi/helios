import { describe, it, expect, vi, beforeEach } from "vitest";
import { evaluateProcessExit } from "./process-exit.js";
import type { ProcessExitCondition } from "./types.js";

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

function processCondition(
  overrides: Partial<ProcessExitCondition> = {},
): ProcessExitCondition {
  return {
    kind: "process_exit",
    machineId: "local",
    ...overrides,
  };
}

describe("evaluateProcessExit", () => {
  describe("pid-based checks", () => {
    it("returns true when pid process is not running", async () => {
      const pool = mockPool();
      pool.isProcessRunning.mockResolvedValue(false);
      const result = await evaluateProcessExit(
        processCondition({ pid: 12345 }),
        pool,
      );
      expect(result).toBe(true);
    });

    it("returns false when pid process is running", async () => {
      const pool = mockPool();
      pool.isProcessRunning.mockResolvedValue(true);
      const result = await evaluateProcessExit(
        processCondition({ pid: 12345 }),
        pool,
      );
      expect(result).toBe(false);
    });

    it("calls pool.isProcessRunning with correct machine and pid", async () => {
      const pool = mockPool();
      await evaluateProcessExit(
        processCondition({ machineId: "gpu-box", pid: 9999 }),
        pool,
      );
      expect(pool.isProcessRunning).toHaveBeenCalledWith("gpu-box", 9999);
    });

    it("prefers pid over pattern when both are provided", async () => {
      const pool = mockPool();
      pool.isProcessRunning.mockResolvedValue(true);
      const result = await evaluateProcessExit(
        processCondition({ pid: 123, processPattern: "train.py" }),
        pool,
      );
      expect(result).toBe(false);
      expect(pool.isProcessRunning).toHaveBeenCalled();
      expect(pool.exec).not.toHaveBeenCalled();
    });
  });

  describe("pattern-based checks", () => {
    it("checks process by pattern when no pid given", async () => {
      const pool = mockPool();
      await evaluateProcessExit(
        processCondition({ processPattern: "train.py" }),
        pool,
      );
      expect(pool.exec).toHaveBeenCalledWith(
        "local",
        expect.stringContaining("pgrep"),
      );
    });

    it("pattern match returns false (process still running) when pgrep finds PID", async () => {
      const responses = new Map([
        ["pgrep", { stdout: "12345\n", stderr: "", exitCode: 0 }],
      ]);
      const pool = mockPool(responses);
      const result = await evaluateProcessExit(
        processCondition({ processPattern: "train.py" }),
        pool,
      );
      expect(result).toBe(false);
    });

    it("pattern match returns true (process exited) when pgrep returns empty", async () => {
      const responses = new Map([
        ["pgrep", { stdout: "", stderr: "", exitCode: 1 }],
      ]);
      const pool = mockPool(responses);
      const result = await evaluateProcessExit(
        processCondition({ processPattern: "train.py" }),
        pool,
      );
      expect(result).toBe(true);
    });

    it("pattern is shell-quoted for safety", async () => {
      const pool = mockPool();
      await evaluateProcessExit(
        processCondition({ processPattern: "my script's name" }),
        pool,
      );
      const command = pool.exec.mock.calls[0][1] as string;
      // shellQuote wraps in single quotes and escapes internal single quotes
      expect(command).toContain("'my script'\\''s name'");
    });

    it("calls pool.exec with pgrep command for pattern", async () => {
      const pool = mockPool();
      await evaluateProcessExit(
        processCondition({ processPattern: "python train.py" }),
        pool,
      );
      const command = pool.exec.mock.calls[0][1] as string;
      expect(command).toMatch(/^pgrep -f .* \| head -1$/);
    });

    it("returns true when pgrep output is whitespace only", async () => {
      const responses = new Map([
        ["pgrep", { stdout: "   \n", stderr: "", exitCode: 0 }],
      ]);
      const pool = mockPool(responses);
      const result = await evaluateProcessExit(
        processCondition({ processPattern: "train.py" }),
        pool,
      );
      expect(result).toBe(true);
    });
  });

  describe("edge cases", () => {
    it("returns false when neither pid nor pattern given", async () => {
      const pool = mockPool();
      const result = await evaluateProcessExit(processCondition(), pool);
      expect(result).toBe(false);
    });

    it("uses the correct machineId in exec call", async () => {
      const pool = mockPool();
      await evaluateProcessExit(
        processCondition({
          machineId: "remote-gpu",
          processPattern: "train.py",
        }),
        pool,
      );
      expect(pool.exec).toHaveBeenCalledWith(
        "remote-gpu",
        expect.any(String),
      );
    });

    it("uses the correct machineId in isProcessRunning call", async () => {
      const pool = mockPool();
      await evaluateProcessExit(
        processCondition({ machineId: "remote-gpu", pid: 100 }),
        pool,
      );
      expect(pool.isProcessRunning).toHaveBeenCalledWith("remote-gpu", 100);
    });
  });
});
