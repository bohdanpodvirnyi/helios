import {
  query as sdkQuery,
  createSdkMcpServer,
  tool as sdkTool,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  SDKMessage,
  Query,
  Options as SDKOptions,
} from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  ModelProvider,
  ToolDefinition,
  Session,
  SessionConfig,
  AgentEvent,
} from "../types.js";
import type { AuthManager } from "../auth/auth-manager.js";
import { SessionStore } from "../../store/session-store.js";
import { ClaudeOAuth } from "./oauth.js";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL = "claude-sonnet-4-20250514";

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContent[];
}

type AnthropicContent =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

export class ClaudeProvider implements ModelProvider {
  readonly name = "claude" as const;
  readonly displayName = "Claude";

  private authManager: AuthManager;
  private sessionStore: SessionStore;
  private activeQuery: Query | null = null;
  private abortController: AbortController | null = null;
  private sdkSessionIds = new Map<string, string>();
  /** Conversation history for raw API mode */
  private conversationHistory = new Map<string, AnthropicMessage[]>();
  private systemPrompts = new Map<string, string>();

  constructor(authManager: AuthManager) {
    this.authManager = authManager;
    this.sessionStore = new SessionStore();
  }

  async isAuthenticated(): Promise<boolean> {
    return this.authManager.isAuthenticated("claude");
  }

  async authenticate(): Promise<void> {
    const creds = await this.authManager.getCredentials("claude");
    if (creds) return;

    const envKey = process.env.ANTHROPIC_API_KEY;
    if (envKey) {
      await this.authManager.setApiKey("claude", envKey);
      return;
    }

    // Try OAuth flow
    const oauth = new ClaudeOAuth(this.authManager);
    await oauth.login();
  }

  async createSession(config: SessionConfig): Promise<Session> {
    const creds = await this.authManager.getCredentials("claude");
    if (!creds) throw new Error("Not authenticated with Claude");

    const session = this.sessionStore.createSession(
      "claude",
      config.model ?? DEFAULT_MODEL,
    );

    if (config.systemPrompt) {
      this.systemPrompts.set(session.id, config.systemPrompt);
    }

    // Initialize conversation history for raw API mode
    this.conversationHistory.set(session.id, []);

    return session;
  }

  async resumeSession(id: string): Promise<Session> {
    const session = this.sessionStore.getSession(id);
    if (!session) throw new Error(`Session ${id} not found`);
    if (!this.conversationHistory.has(id)) {
      this.conversationHistory.set(id, []);
    }
    return session;
  }

  async *send(
    session: Session,
    message: string,
    tools: ToolDefinition[],
  ): AsyncGenerator<AgentEvent> {
    const creds = await this.authManager.getCredentials("claude");
    if (!creds) throw new Error("Not authenticated");

    if (creds.method === "api_key") {
      yield* this.sendViaAgentSdk(session, message, tools, creds.apiKey!);
    } else {
      yield* this.sendViaRawApi(session, message, tools, creds.accessToken!);
    }
  }

  interrupt(_session: Session): void {
    if (this.activeQuery) {
      this.activeQuery.interrupt();
    }
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  async closeSession(session: Session): Promise<void> {
    if (this.activeQuery) {
      this.activeQuery.close();
      this.activeQuery = null;
    }
    this.sdkSessionIds.delete(session.id);
    this.conversationHistory.delete(session.id);
    this.systemPrompts.delete(session.id);
  }

  // ========== Agent SDK Mode (API Key) ==========

  private async *sendViaAgentSdk(
    session: Session,
    message: string,
    tools: ToolDefinition[],
    apiKey: string,
  ): AsyncGenerator<AgentEvent> {
    const mcpServer = this.buildMcpServer(tools);

    const options: SDKOptions = {
      model: DEFAULT_MODEL,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      includePartialMessages: true,
      maxTurns: 50,
      mcpServers: { helios: mcpServer },
      tools: [],
      persistSession: false,
    };

    const sdkSessionId = this.sdkSessionIds.get(session.id);
    if (sdkSessionId) {
      options.resume = sdkSessionId;
    }

    process.env.ANTHROPIC_API_KEY = apiKey;

    const q = sdkQuery({ prompt: message, options });
    this.activeQuery = q;

    try {
      for await (const msg of q) {
        if (
          "session_id" in msg &&
          msg.session_id &&
          !this.sdkSessionIds.has(session.id)
        ) {
          this.sdkSessionIds.set(session.id, msg.session_id);
          session.providerSessionId = msg.session_id;
        }
        yield* this.mapSdkMessage(msg);
      }
    } finally {
      this.activeQuery = null;
    }
  }

  // ========== Raw API Mode (OAuth) ==========

  private async *sendViaRawApi(
    session: Session,
    message: string,
    tools: ToolDefinition[],
    accessToken: string,
  ): AsyncGenerator<AgentEvent> {
    const history = this.conversationHistory.get(session.id) ?? [];
    history.push({ role: "user", content: message });

    // Agent loop: send → response → tool calls → repeat
    let continueLoop = true;
    while (continueLoop) {
      continueLoop = false;

      const { text, toolCalls, usage } = await this.callRawApi(
        session,
        accessToken,
        history,
        tools,
      );

      if (text) {
        yield { type: "text", text, delta: text };
      }

      if (toolCalls.length > 0) {
        // Add assistant response with tool uses
        const assistantContent: AnthropicContent[] = [];
        if (text) assistantContent.push({ type: "text", text });
        for (const tc of toolCalls) {
          assistantContent.push({
            type: "tool_use",
            id: tc.id,
            name: tc.name,
            input: tc.args,
          });
        }
        history.push({ role: "assistant", content: assistantContent });

        // Execute tools and build result message
        const toolResults: AnthropicContent[] = [];
        for (const tc of toolCalls) {
          yield { type: "tool_call", id: tc.id, name: tc.name, args: tc.args };

          const tool = tools.find((t) => t.name === tc.name);
          let result: string;
          let isError = false;

          if (!tool) {
            result = `Unknown tool: ${tc.name}`;
            isError = true;
          } else {
            try {
              result = await tool.execute(tc.args);
            } catch (err) {
              result = `Error: ${err instanceof Error ? err.message : String(err)}`;
              isError = true;
            }
          }

          yield { type: "tool_result", callId: tc.id, result, isError };
          toolResults.push({
            type: "tool_result",
            tool_use_id: tc.id,
            content: result,
            is_error: isError,
          });
        }

        history.push({ role: "user", content: toolResults });
        continueLoop = true;
      } else {
        if (text) {
          history.push({ role: "assistant", content: text });
        }
        yield {
          type: "done",
          usage: usage
            ? { inputTokens: usage.input, outputTokens: usage.output }
            : undefined,
        };
      }
    }

    this.conversationHistory.set(session.id, history);
  }

  private async callRawApi(
    session: Session,
    accessToken: string,
    messages: AnthropicMessage[],
    tools: ToolDefinition[],
  ): Promise<{
    text: string;
    toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }>;
    usage?: { input: number; output: number };
  }> {
    this.abortController = new AbortController();

    const toolDefs =
      tools.length > 0
        ? tools.map((t) => ({
            name: t.name,
            description: t.description,
            input_schema: {
              type: "object" as const,
              properties: t.parameters.properties,
              required: t.parameters.required,
            },
          }))
        : undefined;

    const body: Record<string, unknown> = {
      model: DEFAULT_MODEL,
      max_tokens: 8192,
      messages,
      stream: false,
    };

    const systemPrompt = this.systemPrompts.get(session.id);
    if (systemPrompt) {
      body.system = systemPrompt;
    }
    if (toolDefs) {
      body.tools = toolDefs;
    }

    const resp = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
      signal: this.abortController.signal,
    });

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Anthropic API error: ${resp.status} ${errText}`);
    }

    const data = (await resp.json()) as {
      content: Array<
        | { type: "text"; text: string }
        | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
      >;
      usage?: { input_tokens: number; output_tokens: number };
    };

    let text = "";
    const toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }> = [];

    for (const block of data.content) {
      if (block.type === "text") {
        text += block.text;
      } else if (block.type === "tool_use") {
        toolCalls.push({
          id: block.id,
          name: block.name,
          args: block.input,
        });
      }
    }

    return {
      text,
      toolCalls,
      usage: data.usage
        ? { input: data.usage.input_tokens, output: data.usage.output_tokens }
        : undefined,
    };
  }

  // ========== Shared Utilities ==========

  private buildMcpServer(tools: ToolDefinition[]) {
    const mcpTools = tools.map((t) =>
      sdkTool(
        t.name,
        t.description,
        this.buildZodSchema(t),
        async (args: Record<string, unknown>) => {
          try {
            const result = await t.execute(args);
            return { content: [{ type: "text" as const, text: result }] };
          } catch (err) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Error: ${err instanceof Error ? err.message : String(err)}`,
                },
              ],
              isError: true,
            };
          }
        },
      ),
    );

    return createSdkMcpServer({ name: "helios-tools", tools: mcpTools });
  }

  private buildZodSchema(
    tool: ToolDefinition,
  ): Record<string, z.ZodTypeAny> {
    const shape: Record<string, z.ZodTypeAny> = {};
    const props = tool.parameters.properties as Record<
      string,
      { type?: string; description?: string; enum?: string[] }
    >;
    const required = new Set(tool.parameters.required ?? []);

    for (const [key, prop] of Object.entries(props)) {
      let field: z.ZodTypeAny;

      if (prop.enum) {
        field = z.enum(prop.enum as [string, ...string[]]);
      } else {
        switch (prop.type) {
          case "number":
            field = z.number();
            break;
          case "boolean":
            field = z.boolean();
            break;
          case "array":
            field = z.array(z.any());
            break;
          case "object":
            field = z.record(z.string(), z.any());
            break;
          default:
            field = z.string();
        }
      }

      if (prop.description) field = field.describe(prop.description);
      if (!required.has(key)) field = field.optional();
      shape[key] = field;
    }

    return shape;
  }

  private *mapSdkMessage(msg: SDKMessage): Generator<AgentEvent> {
    switch (msg.type) {
      case "assistant": {
        const textBlocks = msg.message.content.filter(
          (b: { type: string }) => b.type === "text",
        );
        const text = textBlocks
          .map((b: { type: "text"; text: string }) => b.text)
          .join("");
        if (text) yield { type: "text", text, delta: text };

        const toolUseBlocks = msg.message.content.filter(
          (b: { type: string }) => b.type === "tool_use",
        );
        for (const block of toolUseBlocks) {
          const tu = block as {
            type: "tool_use";
            id: string;
            name: string;
            input: Record<string, unknown>;
          };
          yield { type: "tool_call", id: tu.id, name: tu.name, args: tu.input };
        }
        break;
      }

      case "stream_event": {
        const event = msg.event;
        if (
          event.type === "content_block_delta" &&
          event.delta.type === "text_delta"
        ) {
          yield { type: "text", text: event.delta.text, delta: event.delta.text };
        }
        break;
      }

      case "result": {
        if (msg.subtype === "success") {
          yield {
            type: "done",
            usage: {
              inputTokens: msg.usage.input_tokens,
              outputTokens: msg.usage.output_tokens,
              costUsd: msg.total_cost_usd,
            },
          };
        } else {
          const errMsg = msg as { errors?: string[] };
          yield {
            type: "error",
            error: new Error(errMsg.errors?.join("; ") ?? "Unknown SDK error"),
            recoverable: false,
          };
          yield { type: "done" };
        }
        break;
      }

      default:
        break;
    }
  }
}
