import type { MetricCondition, Comparator } from "./types.js";
import type { ConnectionPool } from "../../remote/connection-pool.js";
import { shellQuote } from "../../ui/format.js";

export async function evaluateMetric(
  condition: MetricCondition,
  pool: ConnectionPool,
): Promise<boolean> {
  const value = await fetchMetricValue(condition, pool);
  if (value === null) return false;
  return compareValue(value, condition.comparator, condition.threshold);
}

async function fetchMetricValue(
  condition: MetricCondition,
  pool: ConnectionPool,
): Promise<number | null> {
  const { source, machineId, field } = condition;

  switch (source.type) {
    case "json_file": {
      const result = await pool.exec(
        machineId,
        `cat ${shellQuote(source.path)} 2>/dev/null`,
      );
      if (result.exitCode !== 0) return null;
      try {
        const data = JSON.parse(result.stdout);
        return extractField(data, field);
      } catch {
        return null;
      }
    }

    case "csv_file": {
      // Read header + last line in a single SSH call
      const result = await pool.exec(
        machineId,
        `{ head -1 ${shellQuote(source.path)} && tail -1 ${shellQuote(source.path)}; } 2>/dev/null`,
      );
      if (result.exitCode !== 0 || !result.stdout.trim()) return null;
      const lines = result.stdout.trim().split("\n");
      if (lines.length < 2) return null;
      const headers = lines[0].split(",");
      const values = lines[lines.length - 1].split(",");
      const idx = headers.indexOf(field);
      if (idx === -1) return null;
      return parseFloat(values[idx]);
    }

    case "command": {
      const result = await pool.exec(machineId, source.command);
      if (result.exitCode !== 0) return null;
      const num = parseFloat(result.stdout.trim());
      return isNaN(num) ? null : num;
    }

    case "tensorboard":
      // TensorBoard metrics are collected via the MetricCollector pipeline, not inline
      return null;
  }
}

function extractField(obj: unknown, path: string): number | null {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current == null || typeof current !== "object") return null;
    current = (current as Record<string, unknown>)[part];
  }
  return typeof current === "number" ? current : null;
}

export { type Comparator } from "./types.js";

export function compareValue(
  value: number,
  comparator: Comparator,
  threshold: number,
): boolean {
  switch (comparator) {
    case "<":
      return value < threshold;
    case ">":
      return value > threshold;
    case "<=":
      return value <= threshold;
    case ">=":
      return value >= threshold;
    case "==":
      return value === threshold;
    case "!=":
      return value !== threshold;
    default:
      return false;
  }
}
