import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import { Layout } from "./ui/layout.js";
import { Orchestrator } from "./core/orchestrator.js";
import { ClaudeProvider } from "./providers/claude/provider.js";
import { OpenAIProvider } from "./providers/openai/provider.js";
import { AuthManager } from "./providers/auth/auth-manager.js";
import { OpenAIOAuth } from "./providers/openai/oauth.js";
import { ClaudeOAuth } from "./providers/claude/oauth.js";
import { ConnectionPool } from "./remote/connection-pool.js";
import { RemoteExecutor } from "./remote/executor.js";
import { FileSync } from "./remote/file-sync.js";
import { TriggerScheduler } from "./scheduler/trigger-scheduler.js";
import { SleepManager } from "./scheduler/sleep-manager.js";
import { MetricStore } from "./metrics/store.js";
import { MetricCollector } from "./metrics/collector.js";
import {
  createRemoteExecTool,
  createRemoteExecBackgroundTool,
} from "./tools/remote-exec.js";
import {
  createUploadTool,
  createDownloadTool,
} from "./tools/remote-sync.js";
import { createMetricsQueryTool } from "./tools/metrics-query.js";
import { createSleepTool } from "./tools/sleep.js";
import { createListMachinesTool } from "./tools/list-machines.js";

const SYSTEM_PROMPT = `You are Helios, an autonomous ML research agent. You help researchers design, run, and monitor machine learning experiments on remote machines.

Your capabilities:
- Execute commands on remote machines via SSH (remote_exec, remote_exec_background)
- Launch and monitor training runs
- Track metrics like loss, accuracy, rewards (metrics_query)
- Transfer files between local and remote machines (remote_upload, remote_download)
- Sleep and set triggers to wake on conditions (sleep) — use this for long-running tasks
- List configured machines (list_machines)
- Analyze training curves and suggest adjustments

Your approach:
- Think step-by-step about experiment design
- Monitor for common issues: loss divergence, NaN, OOM, dead GPUs
- Proactively suggest improvements based on observed metrics
- When a training run will take a while, use the sleep tool with appropriate triggers
- Be concise in responses but thorough in analysis

When executing remote commands, always check the exit code and stderr for errors.`;

interface AppProps {
  defaultProvider?: "claude" | "openai";
}

export function App({ defaultProvider = "claude" }: AppProps) {
  const [orchestrator, setOrchestrator] = useState<Orchestrator | null>(
    null,
  );
  const [sleepManager, setSleepManager] = useState<SleepManager | null>(
    null,
  );

  useEffect(() => {
    // Auth
    const authManager = new AuthManager();

    // Register refresh handlers
    const openaiOAuth = new OpenAIOAuth(authManager);
    authManager.registerRefreshHandler(
      "openai",
      (rt) => openaiOAuth.refresh(rt),
    );
    const claudeOAuth = new ClaudeOAuth(authManager);
    authManager.registerRefreshHandler(
      "claude",
      (rt) => claudeOAuth.refresh(rt),
    );

    // Providers
    const claudeProvider = new ClaudeProvider(authManager);
    const openaiProvider = new OpenAIProvider(authManager);

    // Remote
    const connectionPool = new ConnectionPool();
    const executor = new RemoteExecutor(connectionPool);
    const fileSync = new FileSync();

    // Metrics
    const metricStore = new MetricStore();
    const metricCollector = new MetricCollector(connectionPool, metricStore);

    // Orchestrator
    const orch = new Orchestrator({
      defaultProvider,
      systemPrompt: SYSTEM_PROMPT,
    });

    orch.registerProvider(claudeProvider);
    orch.registerProvider(openaiProvider);

    // Register tools
    orch.registerTools([
      createRemoteExecTool(executor),
      createRemoteExecBackgroundTool(executor),
      createUploadTool(fileSync),
      createDownloadTool(fileSync),
      createMetricsQueryTool(metricStore),
      createListMachinesTool(connectionPool),
    ]);

    // Scheduler
    const triggerScheduler = new TriggerScheduler(connectionPool);
    const sleepMgr = new SleepManager(triggerScheduler, orch);

    // Register sleep tool
    orch.registerTool(createSleepTool(sleepMgr));

    setOrchestrator(orch);
    setSleepManager(sleepMgr);

    return () => {
      connectionPool.disconnectAll();
    };
  }, [defaultProvider]);

  if (!orchestrator || !sleepManager) {
    return (
      <Box padding={1}>
        <Text color="yellow">Starting Helios...</Text>
      </Box>
    );
  }

  return (
    <Layout orchestrator={orchestrator} sleepManager={sleepManager} />
  );
}
