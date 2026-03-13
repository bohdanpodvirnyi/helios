import { describe, it, expect, vi } from "vitest";
import { SSHBatcher } from "./ssh-batcher.js";
import type { ConnectionPool } from "../remote/connection-pool.js";

function mockPool(responses: Map<string, { stdout: string; stderr: string; exitCode: number }>): ConnectionPool {
  return {
    exec: vi.fn(async (machineId: string, command: string) => {
      for (const [key, value] of responses) {
        if (command.includes(key)) return value;
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    }),
  } as unknown as ConnectionPool;
}

describe("SSHBatcher", () => {
  it("runs single command directly", async () => {
    const pool = {
      exec: vi.fn().mockResolvedValue({ stdout: "hello", stderr: "", exitCode: 0 }),
    } as unknown as ConnectionPool;

    const batcher = new SSHBatcher(pool);
    const p = batcher.enqueue("local", "echo hello", "cmd1");
    await batcher.flush();

    expect(await p).toBe("hello");
    expect(pool.exec).toHaveBeenCalledOnce();
  });

  it("batches multiple commands for same host", async () => {
    const pool = {
      exec: vi.fn().mockResolvedValue({
        stdout: "---HELIOS_DELIM:cmd1---\nout1\n---HELIOS_DELIM:cmd2---\nout2\n",
        stderr: "",
        exitCode: 0,
      }),
    } as unknown as ConnectionPool;

    const batcher = new SSHBatcher(pool);
    const p1 = batcher.enqueue("remote1", "cmd1", "cmd1");
    const p2 = batcher.enqueue("remote1", "cmd2", "cmd2");
    await batcher.flush();

    expect(await p1).toBe("out1");
    expect(await p2).toBe("out2\n");
    // Only 1 SSH call for 2 commands
    expect(pool.exec).toHaveBeenCalledOnce();
  });

  it("separates commands by host", async () => {
    const pool = {
      exec: vi.fn().mockResolvedValue({ stdout: "ok", stderr: "", exitCode: 0 }),
    } as unknown as ConnectionPool;

    const batcher = new SSHBatcher(pool);
    batcher.enqueue("host1", "cmd1", "a");
    batcher.enqueue("host2", "cmd2", "b");
    await batcher.flush();

    // 2 SSH calls — one per host
    expect(pool.exec).toHaveBeenCalledTimes(2);
  });

  it("rejects all promises on exec error", async () => {
    const pool = {
      exec: vi.fn().mockRejectedValue(new Error("connection lost")),
    } as unknown as ConnectionPool;

    const batcher = new SSHBatcher(pool);
    const p1 = batcher.enqueue("remote1", "cmd1", "a");
    const p2 = batcher.enqueue("remote1", "cmd2", "b");
    await batcher.flush();

    await expect(p1).rejects.toThrow("connection lost");
    await expect(p2).rejects.toThrow("connection lost");
  });

  it("clears pending after flush", async () => {
    const pool = {
      exec: vi.fn().mockResolvedValue({ stdout: "ok", stderr: "", exitCode: 0 }),
    } as unknown as ConnectionPool;

    const batcher = new SSHBatcher(pool);
    batcher.enqueue("host1", "cmd1", "a");
    await batcher.flush();

    // Second flush should not execute anything
    await batcher.flush();
    expect(pool.exec).toHaveBeenCalledOnce();
  });
});
