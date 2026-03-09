import { randomUUID } from "node:crypto";
import type {
  ModelProvider,
  ToolDefinition,
  Session,
  SessionConfig,
  AgentEvent,
} from "../types.js";
import type { AuthManager } from "../auth/auth-manager.js";
import { SessionStore } from "../../store/session-store.js";
import { OpenAIOAuth } from "./oauth.js";

const CODEX_API_URL =
  "https://chatgpt.com/backend-api/codex/responses";

interface ConversationMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
}

export class OpenAIProvider implements ModelProvider {
  readonly name = "openai" as const;
  readonly displayName = "OpenAI";

  private authManager: AuthManager;
  private sessionStore: SessionStore;
  private oauth: OpenAIOAuth;
  private abortController: AbortController | null = null;
  /** Conversation history per session for multi-turn */
  private conversationHistory = new Map<string, ConversationMessage[]>();

  constructor(authManager: AuthManager) {
    this.authManager = authManager;
    this.sessionStore = new SessionStore();
    this.oauth = new OpenAIOAuth(authManager);
  }

  async isAuthenticated(): Promise<boolean> {
    return this.authManager.isAuthenticated("openai");
  }

  async authenticate(): Promise<void> {
    const creds = await this.authManager.getCredentials("openai");
    if (creds && !this.authManager.tokenStore.isExpired("openai"))
      return;

    // Try refresh first
    if (creds?.refreshToken) {
      try {
        const tokens = await this.oauth.refresh(creds.refreshToken);
        await this.authManager.setOAuthTokens(
          "openai",
          tokens.accessToken,
          tokens.refreshToken,
          tokens.expiresAt,
        );
        return;
      } catch {
        // Refresh failed, do full login
      }
    }

    await this.oauth.login();
  }

  async createSession(config: SessionConfig): Promise<Session> {
    const session = this.sessionStore.createSession(
      "openai",
      config.model ?? "gpt-4.1",
    );
    this.conversationHistory.set(session.id, []);

    if (config.systemPrompt) {
      this.conversationHistory.get(session.id)!.push({
        role: "system",
        content: config.systemPrompt,
      });
    }

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
    const creds = await this.authManager.getCredentials("openai");
    if (!creds?.accessToken) throw new Error("Not authenticated");

    const history = this.conversationHistory.get(session.id) ?? [];
    history.push({ role: "user", content: message });

    // Agent loop: send → get response → execute tools → repeat
    let continueLoop = true;
    while (continueLoop) {
      continueLoop = false;

      const { text, toolCalls, usage } = await this.callApi(
        creds.accessToken,
        history,
        tools,
      );

      if (text) {
        yield { type: "text", text, delta: text };
        history.push({ role: "assistant", content: text });
      }

      if (toolCalls.length > 0) {
        // Add assistant message with tool calls
        history.push({
          role: "assistant",
          content: "",
          tool_calls: toolCalls.map((tc) => ({
            id: tc.id,
            type: "function",
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.args),
            },
          })),
        });

        // Execute each tool
        for (const tc of toolCalls) {
          yield {
            type: "tool_call",
            id: tc.id,
            name: tc.name,
            args: tc.args,
          };

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
          history.push({
            role: "tool",
            content: result,
            tool_call_id: tc.id,
          });
        }

        // Continue the loop to let the model respond to tool results
        continueLoop = true;
      }

      if (!continueLoop) {
        yield {
          type: "done",
          usage: usage
            ? {
                inputTokens: usage.input_tokens,
                outputTokens: usage.output_tokens,
              }
            : undefined,
        };
      }
    }

    this.conversationHistory.set(session.id, history);
  }

  interrupt(_session: Session): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  async closeSession(session: Session): Promise<void> {
    this.conversationHistory.delete(session.id);
  }

  private async callApi(
    accessToken: string,
    messages: ConversationMessage[],
    tools: ToolDefinition[],
  ): Promise<{
    text: string;
    toolCalls: Array<{
      id: string;
      name: string;
      args: Record<string, unknown>;
    }>;
    usage?: { input_tokens: number; output_tokens: number };
  }> {
    this.abortController = new AbortController();

    const toolDefs =
      tools.length > 0
        ? tools.map((t) => ({
            type: "function" as const,
            function: {
              name: t.name,
              description: t.description,
              parameters: t.parameters,
            },
          }))
        : undefined;

    const body: Record<string, unknown> = {
      model: "gpt-4.1",
      messages: messages.map((m) => {
        const msg: Record<string, unknown> = {
          role: m.role,
          content: m.content,
        };
        if (m.tool_calls) msg.tool_calls = m.tool_calls;
        if (m.tool_call_id) msg.tool_call_id = m.tool_call_id;
        return msg;
      }),
      stream: true,
      store: false,
    };

    if (toolDefs) {
      body.tools = toolDefs;
      body.tool_choice = "auto";
    }

    const sessionId = randomUUID();
    const resp = await fetch(CODEX_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "OpenAI-Beta": "responses=experimental",
        originator: "codex_cli_rs",
        session_id: sessionId,
      },
      body: JSON.stringify(body),
      signal: this.abortController.signal,
    });

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`OpenAI API error: ${resp.status} ${errText}`);
    }

    return this.parseSSEResponse(resp);
  }

  /**
   * Parse SSE stream from the ChatGPT backend.
   * Accumulates text deltas and tool call chunks.
   */
  private async parseSSEResponse(resp: Response): Promise<{
    text: string;
    toolCalls: Array<{
      id: string;
      name: string;
      args: Record<string, unknown>;
    }>;
    usage?: { input_tokens: number; output_tokens: number };
  }> {
    const reader = resp.body?.getReader();
    if (!reader) throw new Error("No response body");

    const decoder = new TextDecoder();
    let buffer = "";
    let text = "";
    const toolCallChunks = new Map<
      number,
      { id: string; name: string; args: string }
    >();
    let usage: { input_tokens: number; output_tokens: number } | undefined;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (data === "[DONE]") continue;

        try {
          const parsed = JSON.parse(data);

          // Handle chat completions streaming format
          if (parsed.choices?.[0]?.delta) {
            const delta = parsed.choices[0].delta;

            if (delta.content) {
              text += delta.content;
            }

            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index ?? 0;
                if (!toolCallChunks.has(idx)) {
                  toolCallChunks.set(idx, {
                    id: tc.id ?? "",
                    name: tc.function?.name ?? "",
                    args: "",
                  });
                }
                const chunk = toolCallChunks.get(idx)!;
                if (tc.id) chunk.id = tc.id;
                if (tc.function?.name) chunk.name = tc.function.name;
                if (tc.function?.arguments)
                  chunk.args += tc.function.arguments;
              }
            }
          }

          // Handle response format (Responses API)
          if (parsed.type === "response.done" && parsed.response) {
            const r = parsed.response;
            if (r.usage) {
              usage = {
                input_tokens: r.usage.input_tokens ?? 0,
                output_tokens: r.usage.output_tokens ?? 0,
              };
            }
            // Extract text from output items
            if (r.output) {
              for (const item of r.output) {
                if (item.type === "message") {
                  for (const c of item.content ?? []) {
                    if (c.type === "output_text") text += c.text;
                  }
                }
              }
            }
          }

          if (parsed.usage) {
            usage = {
              input_tokens: parsed.usage.input_tokens ?? parsed.usage.prompt_tokens ?? 0,
              output_tokens: parsed.usage.output_tokens ?? parsed.usage.completion_tokens ?? 0,
            };
          }
        } catch {
          // Skip unparseable lines
        }
      }
    }

    const toolCalls = Array.from(toolCallChunks.values())
      .filter((tc) => tc.name)
      .map((tc) => ({
        id: tc.id || randomUUID(),
        name: tc.name,
        args: tc.args ? safeJsonParse(tc.args) : {},
      }));

    return { text, toolCalls, usage };
  }
}

function safeJsonParse(str: string): Record<string, unknown> {
  try {
    return JSON.parse(str);
  } catch {
    return {};
  }
}
