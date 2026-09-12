import type { Env } from "../config/env.js";
import type { PublicXAccount, XAccountConfig } from "../config/accounts.js";
import { toPublicAccount } from "../config/accounts.js";
import { ApiError, notFound } from "../lib/errors.js";
import { TtlCache } from "../lib/cache.js";
import type { XClient } from "../x/client.js";
import type { XTweet, XUser } from "../x/types.js";
import type { AccountAnalytics } from "../x/analytics.js";
import { buildAccountAnalytics, classifyTweet } from "../x/analytics.js";

interface AccountSnapshot {
  user: XUser;
  tweets: XTweet[];
}

export interface CacheMeta {
  cached: boolean;
  cache_age_seconds: number;
  cache_ttl_seconds: number;
}

export interface AnalyticsResult {
  data: AccountAnalytics;
  meta: CacheMeta;
}

export type AccountAnalyticsEntry =
  | { account: PublicXAccount; status: "ok"; analytics: AccountAnalytics; meta: CacheMeta }
  | {
      account: PublicXAccount;
      status: "error";
      error: { code: string; message: string };
    };

export interface AnalyticsServiceOptions {
  accounts: XAccountConfig[];
  client: XClient;
  env: Pick<Env, "CACHE_TTL_SECONDS" | "ANALYTICS_TWEET_LIMIT" | "TOP_TWEETS_COUNT">;
  now?: () => Date;
}

export class AnalyticsService {
  private readonly accounts: XAccountConfig[];
  private readonly byId: Map<string, XAccountConfig>;
  private readonly client: XClient;
  private readonly env: AnalyticsServiceOptions["env"];
  private readonly now: () => Date;
  private readonly cache: TtlCache<AccountSnapshot>;

  constructor({ accounts, client, env, now = () => new Date() }: AnalyticsServiceOptions) {
    this.accounts = accounts;
    this.byId = new Map(accounts.map((account) => [account.id, account]));
    this.client = client;
    this.env = env;
    this.now = now;
    this.cache = new TtlCache<AccountSnapshot>(env.CACHE_TTL_SECONDS * 1000, () =>
      this.now().getTime(),
    );
  }

  listAccounts(): PublicXAccount[] {
    return this.accounts.map(toPublicAccount);
  }

  private requireAccount(accountId: string): XAccountConfig {
    const account = this.byId.get(accountId.toLowerCase());
    if (!account) {
      throw notFound(`No configured X account with id "${accountId}".`, {
        available_account_ids: this.accounts.map((candidate) => candidate.id),
      });
    }
    return account;
  }

  private async snapshot(account: XAccountConfig) {
    return this.cache.load(account.id, async () => {
      const user = await this.client.getUserByUsername(account.username, account.bearerToken);
      const { tweets } = await this.client.getUserTweets(user.id, account.bearerToken, {
        maxResults: this.env.ANALYTICS_TWEET_LIMIT,
      });
      return { user, tweets };
    });
  }

  private meta(cached: boolean, ageSeconds: number): CacheMeta {
    return {
      cached,
      cache_age_seconds: ageSeconds,
      cache_ttl_seconds: this.env.CACHE_TTL_SECONDS,
    };
  }

  async getAnalytics(accountId: string): Promise<AnalyticsResult> {
    const account = this.requireAccount(accountId);
    const { value, cached, ageSeconds } = await this.snapshot(account);

    return {
      data: buildAccountAnalytics({
        account,
        user: value.user,
        tweets: value.tweets,
        topTweetsCount: this.env.TOP_TWEETS_COUNT,
        now: this.now(),
      }),
      meta: this.meta(cached, ageSeconds),
    };
  }

  async getProfile(accountId: string) {
    const analytics = await this.getAnalytics(accountId);
    const { account, profile, audience, lifetime, generated_at, source } = analytics.data;
    return {
      data: { account, profile, audience, lifetime, generated_at, source },
      meta: analytics.meta,
    };
  }

  async getTweets(accountId: string) {
    const account = this.requireAccount(accountId);
    const { value, cached, ageSeconds } = await this.snapshot(account);

    return {
      data: {
        account: toPublicAccount(account),
        count: value.tweets.length,
        tweets: value.tweets.map((tweet) => ({
          id: tweet.id,
          url: `https://x.com/${value.user.username}/status/${tweet.id}`,
          created_at: tweet.created_at ?? null,
          text: tweet.text,
          lang: tweet.lang ?? null,
          kind: classifyTweet(tweet),
          metrics: {
            likes: tweet.public_metrics?.like_count ?? 0,
            retweets: tweet.public_metrics?.retweet_count ?? 0,
            replies: tweet.public_metrics?.reply_count ?? 0,
            quotes: tweet.public_metrics?.quote_count ?? 0,
            bookmarks: tweet.public_metrics?.bookmark_count ?? 0,
            impressions: tweet.public_metrics?.impression_count ?? null,
          },
        })),
      },
      meta: this.meta(cached, ageSeconds),
    };
  }

  /**
   * Every configured account, reported separately. One account failing (revoked
   * token, rate limit, suspended handle) must not hide the accounts that worked,
   * so each entry carries its own status.
   */
  async getAllAnalytics(): Promise<{ accounts: AccountAnalyticsEntry[] }> {
    const settled = await Promise.allSettled(
      this.accounts.map(async (account) => this.getAnalytics(account.id)),
    );

    const entries: AccountAnalyticsEntry[] = settled.map((outcome, index) => {
      const account = this.accounts[index]!;
      if (outcome.status === "fulfilled") {
        return {
          account: toPublicAccount(account),
          status: "ok",
          analytics: outcome.value.data,
          meta: outcome.value.meta,
        };
      }

      const reason = outcome.reason;
      const error =
        reason instanceof ApiError
          ? { code: reason.code, message: reason.message }
          : { code: "internal_error", message: "Failed to load analytics for this account." };

      return { account: toPublicAccount(account), status: "error", error };
    });

    return { accounts: entries };
  }
}
