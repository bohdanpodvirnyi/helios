import { EventEmitter } from "node:events";
import { nanoid } from "nanoid";
import type { SubagentInfo, SubagentSpawnConfig } from "./types.js";
import { runSubagent, resolveProviderForModel, type SubagentExecContext } from "./executor.js";
import type { Orchestrator } from "../core/orchestrator.js";
import type { MemoryStore } from "../memory/memory-store.js";
import type { ToolDefinition } from "../providers/types.js";
import { debugLog } from "../paths.js";

export class SubagentManager extends EventEmitter {
  private agents = new Map<string, SubagentInfo>();
  readonly maxDepth: number;

  constructor(maxDepth = 0) {
    super();
    this.maxDepth = maxDepth;
  }

  /** Spawn a subagent. Returns immediately — the agent runs in the background. */
  spawn(
    config: SubagentSpawnConfig,
    orchestrator: Orchestrator,
    allTools: ToolDefinition[],
    parentMemory: MemoryStore,
    parentSessionId: string,
    depth = 0,
  ): SubagentInfo {
    if (this.maxDepth > 0 && depth >= this.maxDepth) {
      throw new Error(`Subagent depth limit reached (max: ${this.maxDepth})`);
    }

    const resolved = resolveProviderForModel(config.model, config.provider, orchestrator);
    const id = nanoid(8);

    const info: SubagentInfo = {
      id,
      parentSessionId,
      depth,
      task: config.task,
      model: resolved.model,
      provider: resolved.provider,
      status: "running",
      createdAt: Date.now(),
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      memoryPrefix: `/subagents/${id}`,
      abortController: new AbortController(),
    };

    this.agents.set(id, info);
    debugLog("subagent", "spawned", { id, model: resolved.model, provider: resolved.provider, depth });
    this.emit("spawned", info);

    // Fire-and-forget — run in background
    const ctx: SubagentExecContext = {
      orchestrator,
      allTools,
      parentMemory,
      parentSessionId,
      depth,
      subagentManager: this,
    };

    runSubagent(info, config, ctx)
      .then(() => {
        if (info.status === "completed") {
          this.emit("completed", info);
        } else if (info.status === "cancelled") {
          this.emit("cancelled", info);
        } else {
          this.emit("failed", info);
        }
      })
      .catch((err) => {
        // Safety net — runSubagent should handle its own errors
        if (info.status === "running") {
          info.status = "failed";
          info.error = String(err);
          info.completedAt = Date.now();
          this.emit("failed", info);
        }
      });

    return info;
  }

  get(id: string): SubagentInfo | undefined {
    return this.agents.get(id);
  }

  listActive(): SubagentInfo[] {
    return [...this.agents.values()].filter((a) => a.status === "running");
  }

  listAll(): SubagentInfo[] {
    return [...this.agents.values()];
  }

  listForSession(parentSessionId: string): SubagentInfo[] {
    return [...this.agents.values()].filter((a) => a.parentSessionId === parentSessionId);
  }

  cancel(id: string): boolean {
    const info = this.agents.get(id);
    if (!info || info.status !== "running") return false;
    info.abortController.abort();
    return true;
  }

  /** Remove completed/failed agents older than maxAgeMs (default: 30 min). */
  prune(maxAgeMs = 30 * 60_000): void {
    const cutoff = Date.now() - maxAgeMs;
    for (const [id, info] of this.agents) {
      if (info.status !== "running" && (info.completedAt ?? 0) < cutoff) {
        this.agents.delete(id);
      }
    }
  }
}
