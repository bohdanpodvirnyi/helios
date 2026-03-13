import type { ProcessExitCondition } from "./types.js";
import type { ConnectionPool } from "../../remote/connection-pool.js";
import { shellQuote } from "../../ui/format.js";

export async function evaluateProcessExit(
  condition: ProcessExitCondition,
  pool: ConnectionPool,
): Promise<boolean> {
  if (condition.pid) {
    const running = await pool.isProcessRunning(
      condition.machineId,
      condition.pid,
    );
    return !running;
  }

  if (condition.processPattern) {
    const result = await pool.exec(
      condition.machineId,
      `pgrep -f ${shellQuote(condition.processPattern)} | head -1`,
    );
    // If no process found, it has exited
    return result.stdout.trim() === "";
  }

  return false;
}
