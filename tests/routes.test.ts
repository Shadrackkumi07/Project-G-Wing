import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { ApiKeyStore } from "../src/auth/apiKey.js";
import type { XAccountConfig } from "../src/config/accounts.js";
import { loadEnv } from "../src/config/env.js";
import { buildServer } from "../src/server.js";
import { AnalyticsService } from "../src/services/analyticsService.js";
import { XClient, type FetchLike } from "../src/x/client.js";
import { createFakeFetch, type FakeFetchOptions } from "./fixtures/xApi.js";

const KEY = "test-key-that-is-long-enough-123";
const AUTH = { authorization: `Bearer ${KEY}` };

const ACCOUNTS: XAccountConfig[] = [
  { id: "main", label: "Main", username: "sampleaccount", bearerToken: "x-token-main" },
  { id: "brand", label: "Brand", username: "brandaccount", bearerToken: "x-token-brand" },
];

interface TestApp {
  app: FastifyInstance;
  calls: string[];
}

async function buildTestApp(
  options: {
    env?: Record<string, string>;
    accounts?: XAccountConfig[];
    fake?: FakeFetchOptions;
    fetchImpl?: FetchLike;
  } = {},
): Promise<TestApp> {
  const env = loadEnv({ NODE_ENV: "test", ...options.env });
  const accounts = options.accounts ?? ACCOUNTS;
  const fake = createFakeFetch(options.fake);
  const fetchImpl = options.fetchImpl ?? fake.fetch;

  const service = new AnalyticsService({
    accounts,
    client: new XClient({
      baseUrl: env.X_API_BASE_URL,
      timeoutMs: env.X_TIMEOUT_MS,
      fetchImpl,
    }),
    env,
  });

  const app = await buildServer({
    env,
    apiKeyStore: ApiKeyStore.fromEnv({ plaintextKeys: KEY }),
    service,
  });
  await app.ready();

  return { app, calls: fake.calls };
}

describe("unauthenticated endpoints", () => {
  it("serves a health probe", async () => {
    const { app } = await buildTestApp();
    const response = await app.inject({ method: "GET", url: "/healthz" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "ok", accounts_configured: 2 });
    await app.close();
  });

  it("serves an endpoint index", async () => {
    const { app } = await buildTestApp();
    const response = await app.inject({ method: "GET", url: "/" });

    expect(response.statusCode).toBe(200);
    expect(response.json().endpoints.length).toBeGreaterThan(0);
    await app.close();
  });

  it("serves the OpenAPI document", async () => {
    const { app } = await buildTestApp();
    const response = await app.inject({ method: "GET", url: "/openapi.json" });

    expect(response.statusCode).toBe(200);
    const spec = response.json();
    expect(spec.paths["/v1/accounts/{accountId}/analytics"]).toBeDefined();
    expect(spec.components.securitySchemes.bearerAuth.scheme).toBe("bearer");
    await app.close();
  });

  it("returns a JSON error for an unknown route", async () => {
    const { app } = await buildTestApp();
    const response = await app.inject({ method: "GET", url: "/nope" });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("not_found");
    await app.close();
  });
});

describe("authentication", () => {
  it("rejects a request with no API key", async () => {
    const { app, calls } = await buildTestApp();
    const response = await app.inject({ method: "GET", url: "/v1/accounts" });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("unauthorized");
    expect(response.headers["www-authenticate"]).toContain("Bearer");
    // The upstream API must never be touched by an unauthenticated caller.
    expect(calls).toHaveLength(0);
    await app.close();
  });

  it("rejects an unrecognised API key", async () => {
    const { app } = await buildTestApp();
    const response = await app.inject({
      method: "GET",
      url: "/v1/accounts",
      headers: { authorization: "Bearer wrong-key-but-also-long-enough" },
    });

    expect(response.statusCode).toBe(401);
    expect(response.headers["www-authenticate"]).toContain("invalid_token");
    await app.close();
  });

  it("accepts a valid API key", async () => {
    const { app } = await buildTestApp();
    const response = await app.inject({ method: "GET", url: "/v1/accounts", headers: AUTH });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      accounts: [
        { id: "main", label: "Main", username: "sampleaccount" },
        { id: "brand", label: "Brand", username: "brandaccount" },
      ],
    });
    await app.close();
  });

  it("never returns an X credential in the account listing", async () => {
    const { app } = await buildTestApp();
    const response = await app.inject({ method: "GET", url: "/v1/accounts", headers: AUTH });

    expect(response.body).not.toContain("x-token-main");
    expect(response.body).not.toContain("bearerToken");
    await app.close();
  });
});

describe("HTTPS enforcement", () => {
  it("refuses a plaintext request when HTTPS is required", async () => {
    const { app } = await buildTestApp({ env: { REQUIRE_HTTPS: "true" } });
    const response = await app.inject({ method: "GET", url: "/v1/accounts", headers: AUTH });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("https_required");
    await app.close();
  });

  it("accepts a request forwarded over HTTPS by the platform's proxy", async () => {
    const { app } = await buildTestApp({ env: { REQUIRE_HTTPS: "true" } });
    const response = await app.inject({
      method: "GET",
      url: "/v1/accounts",
      headers: { ...AUTH, "x-forwarded-proto": "https" },
    });

    expect(response.statusCode).toBe(200);
    await app.close();
  });

  it("leaves the health probe reachable over plain HTTP for platform checks", async () => {
    const { app } = await buildTestApp({ env: { REQUIRE_HTTPS: "true" } });
    const response = await app.inject({ method: "GET", url: "/healthz" });

    expect(response.statusCode).toBe(200);
    await app.close();
  });
});

describe("per-account analytics", () => {
  it("returns analytics for one account", async () => {
    const { app } = await buildTestApp();
    const response = await app.inject({
      method: "GET",
      url: "/v1/accounts/main/analytics",
      headers: AUTH,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.data.account.id).toBe("main");
    expect(body.data.engagement.totals.engagements).toBe(206);
    expect(body.data.composition.original.count).toBe(1);
    expect(body.meta).toMatchObject({ cached: false, cache_ttl_seconds: 300 });
    expect(response.body).not.toContain("x-token-main");
    await app.close();
  });

  it("returns a profile snapshot without the engagement detail", async () => {
    const { app } = await buildTestApp();
    const response = await app.inject({ method: "GET", url: "/v1/accounts/main", headers: AUTH });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.data.audience.followers).toBe(1000);
    expect(body.data.engagement).toBeUndefined();
    await app.close();
  });

  it("returns the posts backing the window with per-post metrics", async () => {
    const { app } = await buildTestApp();
    const response = await app.inject({
      method: "GET",
      url: "/v1/accounts/main/tweets",
      headers: AUTH,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.data.count).toBe(4);
    expect(body.data.tweets[0]).toMatchObject({
      id: "101",
      kind: "original",
      url: "https://x.com/sampleaccount/status/101",
    });
    expect(body.data.tweets[2]!.kind).toBe("retweet");
    await app.close();
  });

  it("reports an unknown account id with the ids that do exist", async () => {
    const { app } = await buildTestApp();
    const response = await app.inject({
      method: "GET",
      url: "/v1/accounts/missing/analytics",
      headers: AUTH,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error).toMatchObject({
      code: "not_found",
      details: { available_account_ids: ["main", "brand"] },
    });
    await app.close();
  });

  it("rejects an account id that could not be valid", async () => {
    const { app } = await buildTestApp();
    const response = await app.inject({
      method: "GET",
      url: "/v1/accounts/not_valid/analytics",
      headers: AUTH,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("bad_request");
    await app.close();
  });

  it("serves a repeated request from cache instead of calling X again", async () => {
    const { app, calls } = await buildTestApp();
    const url = "/v1/accounts/main/analytics";

    const first = await app.inject({ method: "GET", url, headers: AUTH });
    const second = await app.inject({ method: "GET", url, headers: AUTH });

    expect(first.json().meta.cached).toBe(false);
    expect(second.json().meta.cached).toBe(true);
    // One user lookup plus one posts lookup, for both requests combined.
    expect(calls).toHaveLength(2);
    await app.close();
  });

  it("calls X again once the cache is disabled", async () => {
    const { app, calls } = await buildTestApp({ env: { CACHE_TTL_SECONDS: "0" } });
    const url = "/v1/accounts/main/analytics";

    await app.inject({ method: "GET", url, headers: AUTH });
    await app.inject({ method: "GET", url, headers: AUTH });

    expect(calls).toHaveLength(4);
    await app.close();
  });
});

describe("all-account analytics", () => {
  it("reports every configured account separately", async () => {
    const { app } = await buildTestApp();
    const response = await app.inject({ method: "GET", url: "/v1/analytics", headers: AUTH });

    expect(response.statusCode).toBe(200);
    const { accounts } = response.json();
    expect(accounts).toHaveLength(2);
    expect(accounts.map((entry: { account: { id: string } }) => entry.account.id)).toEqual([
      "main",
      "brand",
    ]);
    expect(accounts.every((entry: { status: string }) => entry.status === "ok")).toBe(true);
    await app.close();
  });

  it("keeps a healthy account readable when another account fails", async () => {
    // Only the brand account's upstream lookup fails.
    const fetchImpl: FetchLike = async (url) => {
      const body = url.includes("brandaccount")
        ? { title: "Unauthorized", detail: "Unauthorized" }
        : { data: (await import("./fixtures/xApi.js")).sampleUser };

      if (url.includes("brandaccount")) {
        return new Response(JSON.stringify(body), { status: 401 });
      }
      if (url.includes("/tweets")) {
        const { sampleTweets } = await import("./fixtures/xApi.js");
        return new Response(
          JSON.stringify({ data: sampleTweets, meta: { result_count: sampleTweets.length } }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify(body), { status: 200 });
    };

    const { app } = await buildTestApp({ fetchImpl });
    const response = await app.inject({ method: "GET", url: "/v1/analytics", headers: AUTH });

    expect(response.statusCode).toBe(200);
    const { accounts } = response.json();
    expect(accounts[0]).toMatchObject({ account: { id: "main" }, status: "ok" });
    expect(accounts[1]).toMatchObject({
      account: { id: "brand" },
      status: "error",
      error: { code: "upstream_unauthorized" },
    });
    await app.close();
  });
});

describe("upstream failures", () => {
  it("maps rejected X credentials to a 502 without echoing them", async () => {
    const { app } = await buildTestApp({ fake: { userStatus: 401 } });
    const response = await app.inject({
      method: "GET",
      url: "/v1/accounts/main/analytics",
      headers: AUTH,
    });

    expect(response.statusCode).toBe(502);
    expect(response.json().error.code).toBe("upstream_unauthorized");
    expect(response.body).not.toContain("x-token-main");
    await app.close();
  });

  it("passes an X rate limit through with the reset time", async () => {
    const resetAt = Math.floor(Date.UTC(2026, 8, 12, 1, 0, 0) / 1000);
    const { app } = await buildTestApp({
      fake: {
        userStatus: 429,
        errorBody: { title: "Too Many Requests" },
        headers: { "x-rate-limit-reset": String(resetAt) },
      },
    });

    const response = await app.inject({
      method: "GET",
      url: "/v1/accounts/main/analytics",
      headers: AUTH,
    });

    expect(response.statusCode).toBe(429);
    expect(response.json().error).toMatchObject({
      code: "upstream_rate_limited",
      details: { retry_at: "2026-09-12T01:00:00.000Z" },
    });
    await app.close();
  });

  it("reports an unknown handle as not found", async () => {
    const { app } = await buildTestApp({ fake: { user: undefined, userStatus: 404 } });
    const response = await app.inject({
      method: "GET",
      url: "/v1/accounts/main/analytics",
      headers: AUTH,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("not_found");
    await app.close();
  });

  it("surfaces an unexpected X status as an upstream error", async () => {
    const { app } = await buildTestApp({
      fake: { userStatus: 503, errorBody: { detail: "Service overloaded" } },
    });
    const response = await app.inject({
      method: "GET",
      url: "/v1/accounts/main/analytics",
      headers: AUTH,
    });

    expect(response.statusCode).toBe(502);
    expect(response.json().error.message).toContain("Service overloaded");
    await app.close();
  });
});

describe("rate limiting", () => {
  it("limits how often one API key may call the service", async () => {
    const { app } = await buildTestApp({
      env: { RATE_LIMIT_MAX: "2", RATE_LIMIT_WINDOW_SECONDS: "60" },
    });

    const call = () => app.inject({ method: "GET", url: "/v1/accounts", headers: AUTH });
    expect((await call()).statusCode).toBe(200);
    expect((await call()).statusCode).toBe(200);

    const limited = await call();
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe("rate_limited");
    await app.close();
  });

  it("does not let a rotating unrecognised token mint a fresh allowance", async () => {
    const { app } = await buildTestApp({
      env: { RATE_LIMIT_MAX: "2", RATE_LIMIT_WINDOW_SECONDS: "60" },
    });

    // A different invalid key each time: all must share one IP-based bucket,
    // otherwise an unauthenticated client could brute-force keys unchecked.
    const call = (attempt: number) =>
      app.inject({
        method: "GET",
        url: "/v1/accounts",
        headers: { authorization: `Bearer wrong-key-number-${attempt}-padded` },
      });

    expect((await call(1)).statusCode).toBe(401);
    expect((await call(2)).statusCode).toBe(401);

    const limited = await call(3);
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe("rate_limited");
    await app.close();
  });

  it("keeps a valid key's allowance separate from unauthenticated traffic", async () => {
    const { app } = await buildTestApp({
      env: { RATE_LIMIT_MAX: "2", RATE_LIMIT_WINDOW_SECONDS: "60" },
    });

    // Exhaust the IP bucket with bad keys...
    await app.inject({
      method: "GET",
      url: "/v1/accounts",
      headers: { authorization: "Bearer bad-key-long-enough-to-parse" },
    });
    await app.inject({
      method: "GET",
      url: "/v1/accounts",
      headers: { authorization: "Bearer bad-key-long-enough-to-parse" },
    });

    // ...the real key still has its own.
    const response = await app.inject({ method: "GET", url: "/v1/accounts", headers: AUTH });
    expect(response.statusCode).toBe(200);
    await app.close();
  });
});
