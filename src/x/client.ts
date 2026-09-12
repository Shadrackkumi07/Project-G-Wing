import { ApiError, notFound } from "../lib/errors.js";
import type { XMedia, XTweet, XTweetsPage, XUser } from "./types.js";

const USER_FIELDS = [
  "created_at",
  "description",
  "location",
  "profile_image_url",
  "protected",
  "public_metrics",
  "url",
  "verified",
  "verified_type",
].join(",");

const TWEET_FIELDS = [
  "attachments",
  "conversation_id",
  "created_at",
  "entities",
  "lang",
  "non_public_metrics",
  "organic_metrics",
  "possibly_sensitive",
  "public_metrics",
  "referenced_tweets",
  "text",
].join(",");

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface XClientOptions {
  baseUrl: string;
  timeoutMs: number;
  fetchImpl?: FetchLike;
}

export interface TokenRefreshResult {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
}

export interface AuthorizationCodeTokenResult extends TokenRefreshResult {}

function describeUpstreamError(status: number, body: unknown): string {
  const parsed = (body ?? {}) as {
    title?: string;
    detail?: string;
    errors?: Array<{ message?: string; detail?: string; title?: string }>;
  };
  const first = parsed.errors?.[0];
  const detail = parsed.detail ?? first?.detail ?? first?.message ?? parsed.title ?? first?.title;
  // Useful provider messages are retained, but anything that even resembles
  // credential material is discarded rather than risk reflecting a secret.
  const safeDetail =
    detail &&
    !/(access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|authorization|bearer|api[_ -]?key)/i.test(
      detail,
    )
      ? detail.slice(0, 300)
      : undefined;
  return safeDetail ? `X API responded ${status}: ${safeDetail}` : `X API responded ${status}.`;
}

export class XClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;

  constructor({ baseUrl, timeoutMs, fetchImpl }: XClientOptions) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl ?? ((url, init) => fetch(url, init));
  }

  async getUserByUsername(username: string, bearerToken: string): Promise<XUser> {
    const body = await this.request<{ data?: XUser }>(
      `/users/by/username/${encodeURIComponent(username)}`,
      { "user.fields": USER_FIELDS },
      bearerToken,
    );

    if (!body.data) {
      throw notFound(`X has no account for username "${username}".`, { username });
    }
    return body.data;
  }

  async getAuthenticatedUser(bearerToken: string): Promise<XUser> {
    const body = await this.request<{ data?: XUser }>(
      "/users/me",
      { "user.fields": USER_FIELDS },
      bearerToken,
    );
    if (!body.data) throw new ApiError(502, "upstream_error", "X did not identify a user.");
    return body.data;
  }

  async getUserTweets(
    userId: string,
    bearerToken: string,
    options: { maxResults: number; startTime?: string; endTime?: string },
  ): Promise<XTweetsPage> {
    const tweets: XTweet[] = [];
    const media = new Map<string, XMedia>();
    let paginationToken: string | undefined;
    do {
      const remaining = options.maxResults - tweets.length;
      const query: Record<string, string> = {
        max_results: String(Math.min(Math.max(remaining, 5), 100)),
        "tweet.fields": TWEET_FIELDS,
        expansions: "attachments.media_keys",
        "media.fields": "media_key,type",
      };
      if (options.startTime) query.start_time = options.startTime;
      if (options.endTime) query.end_time = options.endTime;
      if (paginationToken) query.pagination_token = paginationToken;
      const body = await this.request<{
        data?: XTweet[];
        includes?: { media?: XMedia[] };
        meta?: { result_count?: number; next_token?: string };
      }>(`/users/${encodeURIComponent(userId)}/tweets`, query, bearerToken);
      tweets.push(...(body.data ?? []));
      for (const item of body.includes?.media ?? []) media.set(item.media_key, item);
      paginationToken = body.meta?.next_token;
    } while (paginationToken && tweets.length < options.maxResults);
    return {
      tweets: tweets.slice(0, options.maxResults),
      resultCount: tweets.length,
      media: [...media.values()],
    };
  }

  async refreshAccessToken(input: {
    refreshToken: string;
    clientId: string;
    clientSecret?: string;
  }): Promise<TokenRefreshResult> {
    const url = new URL(`${this.baseUrl}/oauth2/token`);
    const headers: Record<string, string> = {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    };
    if (input.clientSecret) {
      headers.authorization = `Basic ${Buffer.from(`${input.clientId}:${input.clientSecret}`).toString("base64")}`;
    }
    const response = await this.fetchImpl(url.toString(), {
      method: "POST",
      headers,
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: input.refreshToken,
        client_id: input.clientId,
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const body = (await response.json().catch(() => undefined)) as TokenRefreshResult | undefined;
    if (!response.ok || !body?.access_token) {
      throw new ApiError(502, "token_refresh_failed", "X rejected the token refresh request.");
    }
    return body;
  }

  async exchangeAuthorizationCode(input: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
    clientId: string;
    clientSecret?: string;
  }): Promise<AuthorizationCodeTokenResult> {
    const url = new URL(`${this.baseUrl}/oauth2/token`);
    const headers: Record<string, string> = {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    };
    if (input.clientSecret) {
      headers.authorization = `Basic ${Buffer.from(`${input.clientId}:${input.clientSecret}`).toString("base64")}`;
    }
    let response: Response;
    try {
      response = await this.fetchImpl(url.toString(), {
        method: "POST",
        headers,
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: input.code,
          redirect_uri: input.redirectUri,
          client_id: input.clientId,
          code_verifier: input.codeVerifier,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new ApiError(
        504,
        "upstream_unavailable",
        "Could not reach X to exchange the authorization code.",
      );
    }
    const body = (await response.json().catch(() => undefined)) as
      AuthorizationCodeTokenResult | undefined;
    if (!response.ok || !body?.access_token) {
      throw new ApiError(
        502,
        "oauth_exchange_failed",
        "X rejected the authorization code exchange.",
      );
    }
    return body;
  }

  private async request<T>(
    path: string,
    query: Record<string, string>,
    bearerToken: string,
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }

    let response: Response | undefined;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        response = await this.fetchImpl(url.toString(), {
          method: "GET",
          headers: {
            authorization: `Bearer ${bearerToken}`,
            accept: "application/json",
          },
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        // Retry transient server failures. A 429 is intentionally not retried:
        // its reset timestamp must be honored by the caller/scheduler.
        if (![500, 502, 503, 504].includes(response.status) || attempt === 2) break;
        await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** attempt));
      } catch (cause) {
        if (attempt < 2) {
          await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** attempt));
          continue;
        }
        const timedOut = cause instanceof Error && cause.name === "TimeoutError";
        throw new ApiError(
          504,
          "upstream_unavailable",
          timedOut
            ? `The X API did not respond within ${this.timeoutMs}ms.`
            : "Could not reach the X API.",
        );
      }
    }
    if (!response) throw new ApiError(504, "upstream_unavailable", "Could not reach the X API.");

    const payload = await response.json().catch(() => undefined);

    if (response.ok) {
      return payload as T;
    }

    if (response.status === 401 || response.status === 403) {
      throw new ApiError(
        502,
        "upstream_unauthorized",
        "The configured X API credentials were rejected. Check the Bearer token and that the " +
          "app has the required access level.",
      );
    }

    if (response.status === 429) {
      const resetAt = response.headers.get("x-rate-limit-reset");
      throw new ApiError(
        429,
        "upstream_rate_limited",
        "The X API rate limit for these credentials is exhausted. Retry after the reset time.",
        resetAt ? { retry_at: new Date(Number(resetAt) * 1000).toISOString() } : undefined,
      );
    }

    if (response.status === 404) {
      throw notFound("The X API reported that this resource does not exist.");
    }

    throw new ApiError(502, "upstream_error", describeUpstreamError(response.status, payload));
  }
}
