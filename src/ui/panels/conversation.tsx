import React from "react";
import { Box, Text } from "ink";
import type { Message } from "../layout.js";

interface ConversationPanelProps {
  messages: Message[];
  isStreaming: boolean;
}

export function ConversationPanel({
  messages,
  isStreaming,
}: ConversationPanelProps) {
  if (messages.length === 0) {
    return (
      <Box
        flexDirection="column"
        alignItems="center"
        justifyContent="center"
        flexGrow={1}
        paddingX={2}
      >
        <Text color="magenta" bold>
          HELIOS
        </Text>
        <Text color="gray">Autonomous ML Research Agent</Text>
        <Text color="gray" dimColor>
          Send a message to start, or /help for commands
        </Text>
      </Box>
    );
  }

  const visibleMessages = messages.slice(-50);

  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1}>
      {visibleMessages.map((msg) => (
        <MessageBubble key={msg.id} message={msg} />
      ))}
      {isStreaming && (
        <Text color="yellow" dimColor>
          ...
        </Text>
      )}
    </Box>
  );
}

function MessageBubble({ message }: { message: Message }) {
  const { role, content } = message;

  switch (role) {
    case "user":
      return (
        <Box marginBottom={1}>
          <Text color="blue" bold>
            {">"}{" "}
          </Text>
          <Text wrap="wrap">{content}</Text>
        </Box>
      );

    case "assistant":
      return (
        <Box marginBottom={1} flexDirection="column">
          <Text wrap="wrap">{content}</Text>
        </Box>
      );

    case "tool":
      return (
        <Box>
          <Text color="gray" dimColor>
            {content}
          </Text>
        </Box>
      );

    case "error":
      return (
        <Box marginBottom={1}>
          <Text color="red">Error: {content}</Text>
        </Box>
      );

    case "system":
      return (
        <Box marginBottom={1}>
          <Text color="yellow">{content}</Text>
        </Box>
      );

    default:
      return (
        <Box marginBottom={1}>
          <Text wrap="wrap">{content}</Text>
        </Box>
      );
  }
}
