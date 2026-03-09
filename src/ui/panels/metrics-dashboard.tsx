import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";

interface MetricsDashboardProps {
  active: boolean;
  metricData?: Map<string, number[]>;
}

export function MetricsDashboard({
  active,
  metricData,
}: MetricsDashboardProps) {
  if (!metricData || metricData.size === 0) {
    return (
      <Box flexDirection="column" paddingX={1} flexGrow={1}>
        <Text bold color={active ? "cyan" : "white"}>
          Metrics
        </Text>
        <Text color="gray" dimColor>
          No active metrics. Start a training run to see live charts.
        </Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1} flexGrow={1}>
      <Text bold color={active ? "cyan" : "white"}>
        Metrics
      </Text>
      {Array.from(metricData.entries()).map(([name, values]) => (
        <Box key={name}>
          <Text color="gray">
            {name.padEnd(15)}{" "}
          </Text>
          <Text color="cyan">{sparkline(values, 30)}</Text>
          <Text color="white">
            {" "}
            {values.length > 0
              ? values[values.length - 1].toPrecision(4)
              : "—"}
          </Text>
        </Box>
      ))}
    </Box>
  );
}

/**
 * Render a sparkline from values using block characters.
 */
export function sparkline(values: number[], width = 40): string {
  if (values.length === 0) return "";

  const blocks = [
    " ",
    "\u2581",
    "\u2582",
    "\u2583",
    "\u2584",
    "\u2585",
    "\u2586",
    "\u2587",
    "\u2588",
  ];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;

  // Sample to fit width
  const step = Math.max(1, Math.floor(values.length / width));
  const sampled: number[] = [];
  for (let i = 0; i < values.length; i += step) {
    sampled.push(values[i]);
    if (sampled.length >= width) break;
  }

  return sampled
    .map((v) => {
      const idx = Math.round(
        ((v - min) / range) * (blocks.length - 1),
      );
      return blocks[idx];
    })
    .join("");
}
