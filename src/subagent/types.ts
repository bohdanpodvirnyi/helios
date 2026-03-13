export type SubagentStatus = "running" | "completed" | "failed" | "cancelled";

export interface SubagentInfo {
  id: string;
  parentSessionId: string;
  depth: number;
  task: string;
  model: string;
  provider: "claude" | "openai";
  status: SubagentStatus;
  createdAt: number;
  completedAt?: number;
  result?: string;
  error?: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  memoryPrefix: string;
  abortController: AbortController;
}

export interface SubagentSpawnConfig {
  task: string;
  model?: string;
  provider?: "claude" | "openai";
  tools_deny?: string[];
  max_turns?: number;
}
