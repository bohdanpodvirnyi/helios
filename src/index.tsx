#!/usr/bin/env node

import React from "react";
import { render } from "ink";
import { App } from "./app.js";

// Parse CLI args
const args = process.argv.slice(2);
let defaultProvider: "claude" | "openai" = "claude";

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if ((arg === "--provider" || arg === "-p") && args[i + 1]) {
    const p = args[i + 1];
    if (p === "claude" || p === "openai") {
      defaultProvider = p;
    } else {
      console.error(`Unknown provider: ${p}. Use "claude" or "openai".`);
      process.exit(1);
    }
    i++;
  } else if (arg === "--help" || arg === "-h") {
    console.log(`
Helios - Autonomous ML Research Agent

Usage: helios [options]

Options:
  -p, --provider <claude|openai>  Model provider (default: claude)
  -h, --help                      Show this help

Environment:
  ANTHROPIC_API_KEY  Claude API key (for Claude provider with API key auth)

Auth:
  Claude: Set ANTHROPIC_API_KEY or use OAuth login on first run
  OpenAI: OAuth login via ChatGPT Plus/Pro on first run
`);
    process.exit(0);
  }
}

const { waitUntilExit } = render(
  <App defaultProvider={defaultProvider} />,
);

waitUntilExit().then(() => {
  process.exit(0);
});
