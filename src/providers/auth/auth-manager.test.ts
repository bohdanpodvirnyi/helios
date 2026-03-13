import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AuthCredentials } from "../types.js";

// ---------------------------------------------------------------------------
// Mock TokenStore — avoid filesystem access
// ---------------------------------------------------------------------------

function createMockTokenStore() {
  const store = new Map<string, AuthCredentials>();
  return {
    get: vi.fn((provider: string) => store.get(provider) ?? null),
    set: vi.fn((provider: string, creds: AuthCredentials) =>
      store.set(provider, creds),
    ),
    clear: vi.fn((provider: string) => store.delete(provider)),
    isExpired: vi.fn().mockReturnValue(false),
    needsRefresh: vi.fn().mockReturnValue(false),
    _store: store, // escape hatch for assertions
  };
}

let latestMockTokenStore: ReturnType<typeof createMockTokenStore>;

vi.mock("./token-store.js", () => ({
  TokenStore: class {
    constructor() {
      latestMockTokenStore = createMockTokenStore();
      Object.assign(this, latestMockTokenStore);
    }
  },
}));

const { AuthManager } = await import("./auth-manager.js");

describe("AuthManager", () => {
  let manager: InstanceType<typeof AuthManager>;
  let tokenStore: ReturnType<typeof createMockTokenStore>;

  beforeEach(() => {
    manager = new AuthManager();
    tokenStore = latestMockTokenStore;
  });

  // -----------------------------------------------------------------------
  // getCredentials
  // -----------------------------------------------------------------------

  describe("getCredentials", () => {
    it("returns null when no creds stored", async () => {
      const creds = await manager.getCredentials("claude");
      expect(creds).toBeNull();
    });

    it("returns stored API key", async () => {
      const apiCreds: AuthCredentials = {
        method: "api_key",
        provider: "claude",
        apiKey: "sk-ant-test123",
      };
      tokenStore.set("claude", apiCreds);

      const creds = await manager.getCredentials("claude");
      expect(creds).toEqual(apiCreds);
    });

    it("returns stored OAuth tokens", async () => {
      const oauthCreds: AuthCredentials = {
        method: "oauth",
        provider: "openai",
        accessToken: "access-123",
        refreshToken: "refresh-456",
        expiresAt: Date.now() + 3600_000,
      };
      tokenStore.set("openai", oauthCreds);

      const creds = await manager.getCredentials("openai");
      expect(creds).toEqual(oauthCreds);
    });

    it("auto-refreshes when needsRefresh returns true", async () => {
      const oauthCreds: AuthCredentials = {
        method: "oauth",
        provider: "claude",
        accessToken: "old-access",
        refreshToken: "refresh-abc",
        expiresAt: Date.now() - 1000,
      };
      tokenStore.set("claude", oauthCreds);
      tokenStore.needsRefresh.mockReturnValue(true);

      const refreshedTokens = {
        accessToken: "new-access",
        refreshToken: "new-refresh",
        expiresAt: Date.now() + 3600_000,
      };
      manager.registerRefreshHandler("claude", vi.fn().mockResolvedValue(refreshedTokens));

      const creds = await manager.getCredentials("claude");
      expect(creds!.accessToken).toBe("new-access");
      expect(creds!.refreshToken).toBe("new-refresh");
    });

    it("deduplicates concurrent refresh calls", async () => {
      const oauthCreds: AuthCredentials = {
        method: "oauth",
        provider: "claude",
        accessToken: "old",
        refreshToken: "refresh-tok",
        expiresAt: Date.now() - 1000,
      };
      tokenStore.set("claude", oauthCreds);
      tokenStore.needsRefresh.mockReturnValue(true);

      let resolveRefresh!: (val: any) => void;
      const handler = vi.fn(
        () =>
          new Promise<any>((resolve) => {
            resolveRefresh = resolve;
          }),
      );
      manager.registerRefreshHandler("claude", handler);

      // Fire two concurrent getCredentials calls
      const p1 = manager.getCredentials("claude");
      const p2 = manager.getCredentials("claude");

      resolveRefresh({
        accessToken: "refreshed",
        refreshToken: "new-rt",
        expiresAt: Date.now() + 3600_000,
      });

      const [c1, c2] = await Promise.all([p1, p2]);

      // Handler should only be called once
      expect(handler).toHaveBeenCalledTimes(1);
      expect(c1!.accessToken).toBe("refreshed");
      expect(c2!.accessToken).toBe("refreshed");
    });

    it("deduplication clears after completion", async () => {
      const oauthCreds: AuthCredentials = {
        method: "oauth",
        provider: "claude",
        accessToken: "old",
        refreshToken: "rt",
        expiresAt: Date.now() - 1000,
      };
      tokenStore.set("claude", oauthCreds);
      tokenStore.needsRefresh.mockReturnValue(true);

      const handler = vi.fn().mockResolvedValue({
        accessToken: "new1",
        refreshToken: "rt1",
        expiresAt: Date.now() + 3600_000,
      });
      manager.registerRefreshHandler("claude", handler);

      await manager.getCredentials("claude");
      expect(handler).toHaveBeenCalledTimes(1);

      // Second call after first completes should trigger refresh again
      handler.mockResolvedValue({
        accessToken: "new2",
        refreshToken: "rt2",
        expiresAt: Date.now() + 3600_000,
      });
      await manager.getCredentials("claude");
      expect(handler).toHaveBeenCalledTimes(2);
    });

    it("returns stale creds if no refresh handler registered", async () => {
      const oauthCreds: AuthCredentials = {
        method: "oauth",
        provider: "claude",
        accessToken: "stale",
        refreshToken: "rt",
        expiresAt: Date.now() - 1000,
      };
      tokenStore.set("claude", oauthCreds);
      tokenStore.needsRefresh.mockReturnValue(true);

      // No handler registered
      const creds = await manager.getCredentials("claude");
      expect(creds!.accessToken).toBe("stale");
    });

    it("returns stale creds if refresh fails", async () => {
      const oauthCreds: AuthCredentials = {
        method: "oauth",
        provider: "claude",
        accessToken: "stale-token",
        refreshToken: "rt",
        expiresAt: Date.now() - 1000,
      };
      tokenStore.set("claude", oauthCreds);
      tokenStore.needsRefresh.mockReturnValue(true);

      manager.registerRefreshHandler(
        "claude",
        vi.fn().mockRejectedValue(new Error("refresh failed")),
      );

      const creds = await manager.getCredentials("claude");
      expect(creds!.accessToken).toBe("stale-token");
    });
  });

  // -----------------------------------------------------------------------
  // setApiKey
  // -----------------------------------------------------------------------

  describe("setApiKey", () => {
    it("stores API key credentials", async () => {
      await manager.setApiKey("claude", "sk-ant-key-123");

      expect(tokenStore.set).toHaveBeenCalledWith("claude", {
        method: "api_key",
        provider: "claude",
        apiKey: "sk-ant-key-123",
      });
    });

    it("stores for openai provider", async () => {
      await manager.setApiKey("openai", "sk-openai-key");

      expect(tokenStore.set).toHaveBeenCalledWith("openai", {
        method: "api_key",
        provider: "openai",
        apiKey: "sk-openai-key",
      });
    });
  });

  // -----------------------------------------------------------------------
  // setOAuthTokens
  // -----------------------------------------------------------------------

  describe("setOAuthTokens", () => {
    it("stores OAuth credentials", async () => {
      const expiresAt = Date.now() + 3600_000;
      await manager.setOAuthTokens("claude", "access-tok", "refresh-tok", expiresAt);

      expect(tokenStore.set).toHaveBeenCalledWith("claude", {
        method: "oauth",
        provider: "claude",
        accessToken: "access-tok",
        refreshToken: "refresh-tok",
        expiresAt,
      });
    });
  });

  // -----------------------------------------------------------------------
  // isAuthenticated
  // -----------------------------------------------------------------------

  describe("isAuthenticated", () => {
    it("returns false when no creds", () => {
      expect(manager.isAuthenticated("claude")).toBe(false);
    });

    it("returns true with API key", () => {
      tokenStore.set("claude", {
        method: "api_key",
        provider: "claude",
        apiKey: "sk-ant-test",
      });
      expect(manager.isAuthenticated("claude")).toBe(true);
    });

    it("returns true with access token", () => {
      tokenStore.set("openai", {
        method: "oauth",
        provider: "openai",
        accessToken: "access-tok",
        refreshToken: "rt",
        expiresAt: Date.now() + 3600_000,
      });
      expect(manager.isAuthenticated("openai")).toBe(true);
    });

    it("returns true with only refresh token (can try refresh)", () => {
      tokenStore.set("claude", {
        method: "oauth",
        provider: "claude",
        refreshToken: "refresh-only",
        expiresAt: Date.now() - 1000,
      });
      expect(manager.isAuthenticated("claude")).toBe(true);
    });

    it("returns false for API key with empty string", () => {
      tokenStore.set("claude", {
        method: "api_key",
        provider: "claude",
        apiKey: "",
      });
      expect(manager.isAuthenticated("claude")).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // registerRefreshHandler + refresh
  // -----------------------------------------------------------------------

  describe("registerRefreshHandler / refresh", () => {
    it("stores handler", () => {
      const handler = vi.fn();
      manager.registerRefreshHandler("claude", handler);
      // No direct getter, but we can trigger it via getCredentials
      // Just verify no error occurs
      expect(() =>
        manager.registerRefreshHandler("openai", vi.fn()),
      ).not.toThrow();
    });

    it("calls registered handler on refresh", async () => {
      const oauthCreds: AuthCredentials = {
        method: "oauth",
        provider: "claude",
        accessToken: "old",
        refreshToken: "rt-123",
        expiresAt: Date.now() - 1000,
      };
      tokenStore.set("claude", oauthCreds);
      tokenStore.needsRefresh.mockReturnValue(true);

      const handler = vi.fn().mockResolvedValue({
        accessToken: "new-at",
        refreshToken: "new-rt",
        expiresAt: Date.now() + 3600_000,
      });
      manager.registerRefreshHandler("claude", handler);

      await manager.getCredentials("claude");
      expect(handler).toHaveBeenCalledWith("rt-123");
    });

    it("updates token store on successful refresh", async () => {
      const oauthCreds: AuthCredentials = {
        method: "oauth",
        provider: "openai",
        accessToken: "old",
        refreshToken: "rt-abc",
        expiresAt: Date.now() - 1000,
      };
      tokenStore.set("openai", oauthCreds);
      tokenStore.needsRefresh.mockReturnValue(true);

      const newExpires = Date.now() + 7200_000;
      manager.registerRefreshHandler(
        "openai",
        vi.fn().mockResolvedValue({
          accessToken: "fresh-at",
          refreshToken: "fresh-rt",
          expiresAt: newExpires,
        }),
      );

      await manager.getCredentials("openai");

      // tokenStore.set should have been called with the new creds
      expect(tokenStore.set).toHaveBeenCalledWith("openai", {
        method: "oauth",
        provider: "openai",
        accessToken: "fresh-at",
        refreshToken: "fresh-rt",
        expiresAt: newExpires,
      });
    });

    it("returns stale creds on refresh failure", async () => {
      const oauthCreds: AuthCredentials = {
        method: "oauth",
        provider: "claude",
        accessToken: "will-be-stale",
        refreshToken: "rt",
        expiresAt: Date.now() - 1000,
      };
      tokenStore.set("claude", oauthCreds);
      tokenStore.needsRefresh.mockReturnValue(true);

      manager.registerRefreshHandler(
        "claude",
        vi.fn().mockRejectedValue(new Error("network error")),
      );

      const creds = await manager.getCredentials("claude");
      expect(creds!.accessToken).toBe("will-be-stale");
    });
  });

  // -----------------------------------------------------------------------
  // Multiple providers isolated
  // -----------------------------------------------------------------------

  describe("multiple providers", () => {
    it("claude and openai credentials are isolated", async () => {
      await manager.setApiKey("claude", "sk-claude");
      await manager.setOAuthTokens("openai", "at-openai", "rt-openai", Date.now() + 3600_000);

      const claudeCreds = await manager.getCredentials("claude");
      const openaiCreds = await manager.getCredentials("openai");

      expect(claudeCreds!.apiKey).toBe("sk-claude");
      expect(claudeCreds!.method).toBe("api_key");
      expect(openaiCreds!.accessToken).toBe("at-openai");
      expect(openaiCreds!.method).toBe("oauth");
    });

    it("refreshing one provider does not affect the other", async () => {
      const claudeCreds: AuthCredentials = {
        method: "oauth",
        provider: "claude",
        accessToken: "claude-old",
        refreshToken: "claude-rt",
        expiresAt: Date.now() - 1000,
      };
      const openaiCreds: AuthCredentials = {
        method: "oauth",
        provider: "openai",
        accessToken: "openai-stable",
        refreshToken: "openai-rt",
        expiresAt: Date.now() + 3600_000,
      };
      tokenStore.set("claude", claudeCreds);
      tokenStore.set("openai", openaiCreds);

      // Only claude needs refresh
      tokenStore.needsRefresh.mockImplementation(
        (provider: string) => provider === "claude",
      );

      manager.registerRefreshHandler(
        "claude",
        vi.fn().mockResolvedValue({
          accessToken: "claude-new",
          refreshToken: "claude-rt-new",
          expiresAt: Date.now() + 3600_000,
        }),
      );

      const c = await manager.getCredentials("claude");
      const o = await manager.getCredentials("openai");

      expect(c!.accessToken).toBe("claude-new");
      expect(o!.accessToken).toBe("openai-stable");
    });
  });
});
