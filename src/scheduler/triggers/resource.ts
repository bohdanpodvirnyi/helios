import type { ResourceCondition } from "./types.js";
import type { ConnectionPool } from "../../remote/connection-pool.js";
import { compareValue } from "./metric.js";

export async function evaluateResource(
  condition: ResourceCondition,
  pool: ConnectionPool,
): Promise<boolean> {
  const value = await fetchResourceValue(condition, pool);
  if (value === null) return false;
  return compareValue(value, condition.comparator, condition.threshold);
}

async function fetchResourceValue(
  condition: ResourceCondition,
  pool: ConnectionPool,
): Promise<number | null> {
  const { machineId, resource, gpuIndex } = condition;

  switch (resource) {
    case "gpu_util": {
      const idx = gpuIndex ?? 0;
      const result = await pool.exec(
        machineId,
        `nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader,nounits -i ${idx}`,
      );
      if (result.exitCode !== 0) return null;
      return parseFloat(result.stdout.trim());
    }

    case "gpu_memory": {
      const idx = gpuIndex ?? 0;
      const result = await pool.exec(
        machineId,
        `nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader,nounits -i ${idx}`,
      );
      if (result.exitCode !== 0) return null;
      const [used, total] = result.stdout.trim().split(",").map(Number);
      return (used / total) * 100;
    }

    case "cpu": {
      const result = await pool.exec(
        machineId,
        `top -bn1 | grep "Cpu(s)" | awk '{print $2}'`,
      );
      if (result.exitCode !== 0) return null;
      return parseFloat(result.stdout.trim());
    }

    case "memory": {
      const result = await pool.exec(
        machineId,
        `free | grep Mem | awk '{print ($3/$2)*100}'`,
      );
      if (result.exitCode !== 0) return null;
      return parseFloat(result.stdout.trim());
    }

    case "disk": {
      const result = await pool.exec(
        machineId,
        `df / | tail -1 | awk '{print $5}' | tr -d '%'`,
      );
      if (result.exitCode !== 0) return null;
      return parseFloat(result.stdout.trim());
    }
  }
}
