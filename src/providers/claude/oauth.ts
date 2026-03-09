import { randomBytes, createHash } from "node:crypto";
import { exec } from "node:child_process";
import type { AuthManager } from "../auth/auth-manager.js";
import { startCallbackServer } from "../openai/callback-server.js";

const AUTH_URL = "https://claude.ai/oauth/authorize";
const TOKEN_URL = "https://api.anthropic.com/v1/oauth/token";
const REGISTER_URL = "https://api.anthropic.com/v1/oauth/register";
const CALLBACK_PORT = 1456; // Different port from OpenAI
const CALLBACK_PATH = "/callback";
const REDIRECT_URI = `http://127.0.0.1:${CALLBACK_PORT}${CALLBACK_PATH}`;

/**
 * Claude OAuth flow (grey-area).
 *
 * Uses Claude's OAuth PKCE flow to obtain sk-ant-oat01-* tokens.
 * Works with Claude Pro/Max subscriptions.
 * Uses Dynamic Client Registration (RFC 7591).
 *
 * WARNING: Violates Anthropic's ToS for third-party tools.
 */
export class ClaudeOAuth {
  private clientId: string | null = null;

  constructor(private authManager: AuthManager) {}

  async login(): Promise<void> {
    // Step 1: Dynamic Client Registration
    const clientId = await this.registerClient();
    this.clientId = clientId;

    // Step 2: Generate PKCE
    const { verifier, challenge } = generatePKCE();
    const state = randomBytes(32).toString("hex");

    // Step 3: Build auth URL
    const authUrl = buildAuthUrl(clientId, challenge, state);

    // Step 4: Start callback server
    const codePromise = startCallbackServer(
      state,
      CALLBACK_PORT,
      CALLBACK_PATH,
    );

    // Step 5: Open browser
    openBrowser(authUrl);

    // Step 6: Wait for callback
    const { code } = await codePromise;

    // Step 7: Exchange code for tokens
    const tokens = await exchangeCode(clientId, code, verifier);

    // Step 8: Store tokens
    await this.authManager.setOAuthTokens(
      "claude",
      tokens.accessToken,
      tokens.refreshToken,
      tokens.expiresAt,
    );
  }

  async refresh(refreshToken: string): Promise<{
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
  }> {
    const clientId = this.clientId;
    if (!clientId) {
      throw new Error("No client ID — re-authenticate");
    }

    const resp = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        client_id: clientId,
        refresh_token: refreshToken,
      }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(
        `Claude token refresh failed: ${resp.status} ${text}`,
      );
    }

    const data = (await resp.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + data.expires_in * 1000,
    };
  }

  /**
   * Dynamic Client Registration (RFC 7591).
   * Registers a new OAuth client with Anthropic's auth server.
   */
  private async registerClient(): Promise<string> {
    const resp = await fetch(REGISTER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "Helios ML Research Agent",
        redirect_uris: [REDIRECT_URI],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(
        `Client registration failed: ${resp.status} ${text}`,
      );
    }

    const data = (await resp.json()) as { client_id: string };
    return data.client_id;
  }
}

function generatePKCE(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256")
    .update(verifier)
    .digest("base64url");
  return { verifier, challenge };
}

function buildAuthUrl(
  clientId: string,
  challenge: string,
  state: string,
): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    scope: "user:inference user:profile",
  });
  return `${AUTH_URL}?${params.toString()}`;
}

async function exchangeCode(
  clientId: string,
  code: string,
  verifier: string,
): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}> {
  const resp = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT_URI,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(
      `Claude token exchange failed: ${resp.status} ${text}`,
    );
  }

  const data = (await resp.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
}

function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "start"
        : "xdg-open";
  exec(`${cmd} "${url}"`);
}
