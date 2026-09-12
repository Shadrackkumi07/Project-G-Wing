import { ApiError, notFound } from "../lib/errors.js";
import type { XTweet, XTweetsPage, XUser } from "./types.js";

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

const TWEET_FIELDS = ["created_at", "lang", "public_metrics", "referenced_tweets", "text"].join(
  ",",
);

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface XClientOptions {
  baseUrl: string;
  timeoutMs: number;
  fetchImpl?: FetchLike;
}

interface XErrorBody {
  title?: string;
  detail?: string;
  errors?: Array<{ message?: string; detail?: string; title?: string }>;
}

function describeUpstreamError(status: number, body: unknown): string {
  const parsed = (body ?? {}) as XErrorBody;
  const first = parsed.errors?.[0];
  const detail = parsed.detail ?? first?.detail ?? first?.message ?? parsed.title ?? first?.title;
  return detail ? `X API responded ${status}: ${detail}` : `X API responded ${status}.`;
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

  async getUserTweets(
    userId: string,
    bearerToken: string,
    options: { maxResults: number },
  ): Promise<XTweetsPage> {
    const body = await this.request<{ data?: XTweet[]; meta?: { result_count?: number } }>(
      `/users/${encodeURIComponent(userId)}/tweets`,
      {
        max_results: String(options.maxResults),
        "tweet.fields": TWEET_FIELDS,
      },
      bearerToken,
    );

    const tweets = body.data ?? [];
    return { tweets, resultCount: body.meta?.result_count ?? tweets.length };
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

    let response: Response;
    try {
      response = await this.fetchImpl(url.toString(), {
        method: "GET",
        headers: {
          authorization: `Bearer ${bearerToken}`,
          accept: "application/json",
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (cause) {
      const timedOut = cause instanceof Error && cause.name === "TimeoutError";
      throw new ApiError(
        504,
        "upstream_unavailable",
        timedOut
          ? `The X API did not respond within ${this.timeoutMs}ms.`
          : "Could not reach the X API.",
      );
    }

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
