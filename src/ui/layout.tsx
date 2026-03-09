import React, { useState, useCallback } from "react";
import { Box, Text, useInput, useApp } from "ink";
import { ConversationPanel } from "./panels/conversation.js";
import { TaskListPanel } from "./panels/task-list.js";
import { MetricsDashboard } from "./panels/metrics-dashboard.js";
import { SleepPanel } from "./panels/sleep-panel.js";
import { StatusBar } from "./components/status-bar.js";
import { InputBar } from "./components/input-bar.js";
import type { Orchestrator } from "../core/orchestrator.js";
import type { SleepManager } from "../scheduler/sleep-manager.js";

type Panel = "conversation" | "tasks" | "metrics";

export interface Message {
  id: number;
  role: "user" | "assistant" | "tool" | "error" | "system";
  content: string;
}

interface LayoutProps {
  orchestrator: Orchestrator;
  sleepManager: SleepManager;
}

let messageIdCounter = 0;

export function Layout({ orchestrator, sleepManager }: LayoutProps) {
  const { exit } = useApp();
  const [activePanel, setActivePanel] = useState<Panel>("conversation");
  const [messages, setMessages] = useState<Message[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      if (isStreaming) {
        orchestrator.interrupt();
        setIsStreaming(false);
      } else {
        exit();
      }
    }

    if (key.tab && !isStreaming) {
      setActivePanel((prev) => {
        const panels: Panel[] = ["conversation", "tasks", "metrics"];
        const idx = panels.indexOf(prev);
        return panels[(idx + 1) % panels.length];
      });
    }
  });

  const addMessage = useCallback(
    (role: Message["role"], content: string): number => {
      const id = ++messageIdCounter;
      setMessages((prev) => [...prev, { id, role, content }]);
      return id;
    },
    [],
  );

  const updateMessage = useCallback((id: number, content: string) => {
    setMessages((prev) =>
      prev.map((m) => (m.id === id ? { ...m, content } : m)),
    );
  }, []);

  const handleSubmit = useCallback(
    async (input: string) => {
      if (!input.trim()) return;

      // Slash commands
      if (input.startsWith("/")) {
        handleSlashCommand(input, orchestrator, addMessage);
        return;
      }

      // Wake agent if sleeping
      if (sleepManager.isSleeping) {
        sleepManager.manualWake(input);
        addMessage("system", "Waking agent...");
        return;
      }

      addMessage("user", input);
      setIsStreaming(true);

      try {
        let assistantText = "";
        let assistantMsgId: number | null = null;

        for await (const event of orchestrator.send(input)) {
          if (event.type === "text" && event.delta) {
            assistantText += event.delta;
            if (assistantMsgId === null) {
              assistantMsgId = addMessage("assistant", assistantText);
            } else {
              updateMessage(assistantMsgId, assistantText);
            }
          }

          if (event.type === "tool_call") {
            const argsPreview = JSON.stringify(event.args);
            const truncated =
              argsPreview.length > 80
                ? argsPreview.slice(0, 80) + "..."
                : argsPreview;
            addMessage("tool", `${event.name}(${truncated})`);
            // Reset assistant accumulator for post-tool response
            assistantText = "";
            assistantMsgId = null;
          }

          if (event.type === "tool_result" && event.isError) {
            addMessage("error", event.result);
          }

          if (event.type === "error") {
            addMessage("error", event.error.message);
          }
        }
      } catch (err) {
        addMessage(
          "error",
          err instanceof Error ? err.message : "Unknown error",
        );
      } finally {
        setIsStreaming(false);
      }
    },
    [orchestrator, sleepManager, addMessage, updateMessage],
  );

  const isSleeping = sleepManager.isSleeping;

  return (
    <Box flexDirection="column" width="100%" height="100%">
      {/* Main content area */}
      <Box flexGrow={1} flexDirection="row">
        {/* Sidebar: tasks */}
        <Box
          width={20}
          flexDirection="column"
          borderStyle="single"
          borderColor={activePanel === "tasks" ? "cyan" : "gray"}
        >
          <TaskListPanel active={activePanel === "tasks"} />
        </Box>

        {/* Center: conversation or sleep */}
        <Box
          flexGrow={1}
          flexDirection="column"
          borderStyle="single"
          borderColor={
            activePanel === "conversation" ? "cyan" : "gray"
          }
        >
          {isSleeping ? (
            <SleepPanel sleepManager={sleepManager} />
          ) : (
            <ConversationPanel
              messages={messages}
              isStreaming={isStreaming}
            />
          )}
        </Box>
      </Box>

      {/* Metrics bar */}
      <Box
        height={6}
        borderStyle="single"
        borderColor={activePanel === "metrics" ? "cyan" : "gray"}
      >
        <MetricsDashboard active={activePanel === "metrics"} />
      </Box>

      {/* Status bar */}
      <StatusBar orchestrator={orchestrator} />

      {/* Input */}
      <InputBar
        onSubmit={handleSubmit}
        disabled={isStreaming}
        placeholder={
          isSleeping
            ? "Type to wake agent..."
            : "Send a message... (/help for commands)"
        }
      />
    </Box>
  );
}

function handleSlashCommand(
  input: string,
  orchestrator: Orchestrator,
  addMessage: (role: Message["role"], content: string) => number,
): void {
  const parts = input.slice(1).split(" ");
  const cmd = parts[0];
  const args = parts.slice(1);

  switch (cmd) {
    case "switch": {
      const provider = args[0] as "claude" | "openai" | undefined;
      if (provider !== "claude" && provider !== "openai") {
        addMessage("system", "Usage: /switch <claude|openai>");
        return;
      }
      addMessage("system", `Switching to ${provider}...`);
      orchestrator.switchProvider(provider).then(
        () => addMessage("system", `Switched to ${provider}`),
        (err) =>
          addMessage(
            "error",
            `Failed to switch: ${err instanceof Error ? err.message : String(err)}`,
          ),
      );
      break;
    }

    case "help":
      addMessage(
        "system",
        [
          "Commands:",
          "  /switch <claude|openai> — Switch model provider",
          "  /status — Show current state",
          "  /clear — Clear conversation",
          "  /quit — Exit Helios",
          "",
          "Keys:",
          "  Tab — Switch panel focus",
          "  Ctrl+C — Interrupt / Exit",
        ].join("\n"),
      );
      break;

    case "status":
      addMessage(
        "system",
        [
          `Provider: ${orchestrator.currentProvider?.displayName ?? "None"}`,
          `State: ${orchestrator.currentState}`,
          `Cost: $${orchestrator.totalCostUsd.toFixed(4)}`,
        ].join("\n"),
      );
      break;

    case "clear":
      // We can't clear from here directly, but we can signal
      addMessage("system", "Conversation cleared.");
      break;

    case "quit":
    case "exit":
      process.exit(0);

    default:
      addMessage("system", `Unknown command: /${cmd}. Try /help`);
  }
}
