import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ApiKeyStore } from "../src/auth/apiKey.js";
import { loadEnv } from "../src/config/env.js";
import { CredentialVault } from "../src/security/credentialVault.js";
import { buildServer } from "../src/server.js";
import { AnalyticsService } from "../src/services/analyticsService.js";
import { ConnectionService } from "../src/services/connectionService.js";
import { XOAuthService } from "../src/services/xOAuthService.js";
import { Repository } from "../src/storage/repository.js";
import { XClient, type FetchLike } from "../src/x/client.js";
import { sampleTweets, sampleUser } from "./fixtures/xApi.js";

const KEY = "test-key-that-is-long-enough-123";
const AUTH = { authorization: `Bearer ${KEY}` };
const CHATGPT_TOKEN = "chatgpt-test-token-that-is-long-enough-123";
const OAUTH_SETUP_TOKEN = "oauth-setup-token-that-is-long-enough-123";
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

async function fixture(options: { chatGptRateLimitMax?: number } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "x-analytics-test-"));
  directories.push(directory);
  const path = join(directory, "store.json");
  let now = new Date("2026-09-12T00:00:00.000Z");
  const fetchImpl: FetchLike = async (url) => {
    if (url.includes("/oauth2/token")) {
      return Response.json({
        access_token: "oauth-access-token",
        refresh_token: "oauth-refresh-token",
        expires_in: 7200,
        scope: "tweet.read users.read offline.access",
        token_type: "bearer",
      });
    }
    if (url.includes("/users/me")) return Response.json({ data: sampleUser });
    if (url.includes("/tweets")) {
      const tweets = sampleTweets.map((tweet) => ({
        ...tweet,
        entities: {
          urls: [{ expanded_url: "https://example.com/post" }],
          hashtags: [{ tag: "Build" }],
        },
        attachments: { media_keys: ["m1"] },
        non_public_metrics: { impression_count: 1000, url_link_clicks: 12, user_profile_clicks: 8 },
      }));
      return Response.json({
        data: tweets,
        includes: { media: [{ media_key: "m1", type: "photo" }] },
        meta: { result_count: tweets.length },
      });
    }
    return Response.json({ title: "Not Found" }, { status: 404 });
  };
  const env = loadEnv({
    NODE_ENV: "test",
    CACHE_TTL_SECONDS: "300",
    X_CLIENT_ID: "test-client-id",
    X_CLIENT_SECRET: "test-client-secret",
    X_OAUTH_REDIRECT_URI: "https://example.test/auth/x/callback",
    ...(options.chatGptRateLimitMax
      ? { CHATGPT_RATE_LIMIT_MAX: String(options.chatGptRateLimitMax) }
      : {}),
  });
  const repository = new Repository(path);
  const client = new XClient({
    baseUrl: env.X_API_BASE_URL,
    timeoutMs: env.X_TIMEOUT_MS,
    fetchImpl,
  });
  const vault = new CredentialVault(
    repository,
    "a-test-encryption-key-with-more-than-32-characters",
  );
  const connections = new ConnectionService(repository, vault, client, env, () => now);
  const oauth = new XOAuthService(repository, vault, client, connections, env, () => now);
  const legacy = new AnalyticsService({ accounts: [], client, env, now: () => now });
  const app = await buildServer({
    env,
    apiKeyStore: ApiKeyStore.fromEnv({ plaintextKeys: KEY }),
    chatGptTokenStore: ApiKeyStore.fromSingleSecret(CHATGPT_TOKEN, "CHATGPT_ACCESS_TOKEN"),
    oauthSetupTokenStore: ApiKeyStore.fromSingleSecret(OAUTH_SETUP_TOKEN, "OAUTH_SETUP_TOKEN"),
    service: legacy,
    connectionService: connections,
    oauthService: oauth,
  });
  await app.ready();
  return {
    app,
    connections,
    path,
    repository,
    advance(ms: number) {
      now = new Date(now.getTime() + ms);
    },
  };
}

describe("persistent X connections", () => {
  it("detects the authenticated account, encrypts credentials, and never returns them", async () => {
    const { app, path } = await fixture();
    const response = await app.inject({
      method: "POST",
      url: "/v1/connections/x",
      headers: AUTH,
      payload: {
        access_token: "super-secret-user-token",
        scope: "tweet.read users.read offline.access",
      },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      x_account_id: sampleUser.id,
      username: sampleUser.username,
      connection_status: "connected",
    });
    expect(response.body).not.toContain("secret");
    const stored = readFileSync(path, "utf8");
    expect(stored).not.toContain("super-secret-user-token");
    expect(stored).toContain("aes-256-gcm");

    const specification = await app.inject({ method: "GET", url: "/openapi.json" });
    expect(Object.keys(specification.json().components.schemas)).toContain("SafeConnection");
    expect(specification.json().paths).toHaveProperty("/v1/posts/{accountId}/{postId}");
    await app.close();
  });

  it("rejects duplicate accounts and write scopes", async () => {
    const { app } = await fixture();
    const add = () =>
      app.inject({
        method: "POST",
        url: "/v1/connections/x",
        headers: AUTH,
        payload: { access_token: "token", scope: "tweet.read" },
      });
    expect((await add()).statusCode).toBe(201);
    expect((await add()).statusCode).toBe(409);
    const write = await app.inject({
      method: "POST",
      url: "/v1/connections/x",
      headers: AUTH,
      payload: { access_token: "token", scope: "tweet.read tweet.write" },
    });
    expect(write.statusCode).toBe(400);
    await app.close();
  });

  it("serves posts, derived rates, summaries, and durable age snapshots", async () => {
    const { app, connections, repository, path, advance } = await fixture();
    const created = await app.inject({
      method: "POST",
      url: "/v1/connections/x",
      headers: AUTH,
      payload: { access_token: "token" },
    });
    const id = created.json().id as string;
    advance(3_700_000);
    await connections.sync(id);

    const posts = await app.inject({
      method: "GET",
      url: `/v1/posts/${sampleUser.id}?days=30`,
      headers: AUTH,
    });
    expect(posts.statusCode, posts.body).toBe(200);
    expect(posts.json().posts[0]).toMatchObject({
      contains_url: true,
      media_types: ["photo"],
      metrics: { impressions: 1000, click_through_rate: 0.012, profile_visit_rate: 0.008 },
    });

    const detail = await app.inject({
      method: "GET",
      url: `/v1/posts/${sampleUser.id}/101`,
      headers: AUTH,
    });
    expect(detail.json().metric_history).toHaveLength(2);
    expect(detail.json().milestone_snapshots["1h"]).not.toBeNull();

    const summary = await app.inject({
      method: "GET",
      url: `/v1/summary/${sampleUser.id}?days=30`,
      headers: AUTH,
    });
    expect(summary.json()).toHaveProperty("comparisons.last_30_days_vs_previous_30");
    expect(summary.json()).toHaveProperty("topic_performance.#build");
    expect(new Repository(path).postMetrics(sampleUser.id, "101")).toHaveLength(2);
    expect(repository.listConnections()).toHaveLength(1);
    await app.close();
  });

  it("serves only sanitized GET analytics through the ChatGPT URL token", async () => {
    const { app } = await fixture({ chatGptRateLimitMax: 1 });
    await app.inject({
      method: "POST",
      url: "/v1/connections/x",
      headers: AUTH,
      payload: { access_token: "token" },
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/chatgpt/${CHATGPT_TOKEN}/${sampleUser.id}?days=30`,
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      account: { id: sampleUser.id, handle: sampleUser.username, followers: 1000 },
    });
    expect(response.json()).toHaveProperty("summary_7d");
    expect(response.json()).toHaveProperty("summary_30d");
    expect(response.body).not.toContain(CHATGPT_TOKEN);
    expect(response.body).not.toContain("credential_secret_reference");
    expect(response.body).not.toContain("access_token");
    expect(response.body).not.toContain("connection_status");

    const denied = await app.inject({
      method: "GET",
      url: `/api/chatgpt/wrong-token-that-is-also-long-enough-123/${sampleUser.id}`,
    });
    expect(denied.statusCode).toBe(401);
    expect(denied.body).not.toContain("wrong-token");

    const write = await app.inject({
      method: "POST",
      url: `/api/chatgpt/${CHATGPT_TOKEN}/${sampleUser.id}`,
    });
    expect(write.statusCode).toBe(404);
    expect(write.body).not.toContain(CHATGPT_TOKEN);

    const limited = await app.inject({
      method: "GET",
      url: `/api/chatgpt/${CHATGPT_TOKEN}/${sampleUser.id}`,
    });
    expect(limited.statusCode).toBe(429);
    await app.close();
  });

  it("starts OAuth with PKCE and automatically detects the callback account", async () => {
    const { app, path } = await fixture();
    const start = await app.inject({
      method: "GET",
      url: `/auth/x/${OAUTH_SETUP_TOKEN}`,
    });
    expect(start.statusCode, start.body).toBe(302);
    expect(start.headers["cache-control"]).toBe("no-store");
    const authorizationUrl = new URL(start.headers.location!);
    expect(authorizationUrl.origin).toBe("https://x.com");
    expect(authorizationUrl.pathname).toBe("/i/oauth2/authorize");
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
      "https://example.test/auth/x/callback",
    );
    expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256");
    const state = authorizationUrl.searchParams.get("state");
    expect(state).toBeTruthy();

    const beforeCallback = readFileSync(path, "utf8");
    expect(beforeCallback).not.toContain("code_verifier");

    const callback = await app.inject({
      method: "GET",
      url: `/auth/x/callback?code=authorization-code&state=${encodeURIComponent(state!)}`,
    });
    expect(callback.statusCode, callback.body).toBe(200);
    expect(callback.headers["content-type"]).toContain("text/html");
    expect(callback.body).toContain(`@${sampleUser.username}`);
    expect(callback.body).not.toContain("authorization-code");
    expect(callback.body).not.toContain("oauth-access-token");

    const connections = await app.inject({ method: "GET", url: "/v1/connections", headers: AUTH });
    expect(connections.json().connections).toHaveLength(1);
    expect(connections.json().connections[0]).toMatchObject({ x_account_id: sampleUser.id });

    const replay = await app.inject({
      method: "GET",
      url: `/auth/x/callback?code=authorization-code&state=${encodeURIComponent(state!)}`,
    });
    expect(replay.statusCode).toBe(400);
    expect(replay.body).not.toContain(state!);

    const denied = await app.inject({ method: "GET", url: "/auth/x/wrong-setup-token" });
    expect(denied.statusCode).toBe(401);
    expect(denied.body).not.toContain("wrong-setup-token");
    await app.close();
  });
});
