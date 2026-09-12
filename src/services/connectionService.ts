import { randomUUID } from "node:crypto";
import type { Env } from "../config/env.js";
import { ApiError, notFound } from "../lib/errors.js";
import type { CredentialVault, XCredentials } from "../security/credentialVault.js";
import type { Repository } from "../storage/repository.js";
import type {
  AccountSnapshotRecord,
  ConnectionRecord,
  PostMetricRecord,
  PostRecord,
} from "../storage/types.js";
import type { XClient } from "../x/client.js";
import type { XMedia, XTweet, XUser } from "../x/types.js";
import { classifyTweet } from "../x/analytics.js";

const DAY = 86_400_000;
const MILESTONES = [3600, 21_600, 86_400, 259_200, 604_800, 2_592_000];
const MILESTONE_NAMES = ["1h", "6h", "24h", "3d", "7d", "30d"];

export interface NewConnectionInput {
  access_token: string;
  refresh_token?: string;
  token_expires_at?: string;
  token_type?: string;
  scope?: string;
}

export interface SafeConnection {
  id: string;
  platform: "x";
  x_account_id: string;
  username: string;
  display_name: string;
  profile_image_url: string | null;
  connection_status: ConnectionRecord["connection_status"];
  token_expires_at: string | null;
  last_synced_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

function safe(record: ConnectionRecord): SafeConnection {
  const { credential_secret_reference: _secret, ...publicRecord } = record;
  return publicRecord;
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function metricValue(
  tweet: XTweet,
): Omit<PostMetricRecord, "account_id" | "post_id" | "captured_at" | "age_seconds"> {
  const privateMetrics = tweet.non_public_metrics ?? tweet.organic_metrics;
  const publicMetrics = tweet.public_metrics;
  const likes = privateMetrics?.like_count ?? publicMetrics?.like_count ?? 0;
  const replies = privateMetrics?.reply_count ?? publicMetrics?.reply_count ?? 0;
  const reposts = privateMetrics?.retweet_count ?? publicMetrics?.retweet_count ?? 0;
  const quotes = publicMetrics?.quote_count ?? 0;
  const bookmarks = publicMetrics?.bookmark_count ?? null;
  const impressions = privateMetrics?.impression_count ?? publicMetrics?.impression_count ?? null;
  const profileClicks = privateMetrics?.user_profile_clicks ?? null;
  const urlClicks = privateMetrics?.url_link_clicks ?? null;
  return {
    impressions,
    likes,
    replies,
    reposts,
    quotes,
    bookmarks,
    profile_clicks: profileClicks,
    url_clicks: urlClicks,
    user_profile_clicks: profileClicks,
    total_engagements:
      likes +
      replies +
      reposts +
      quotes +
      (bookmarks ?? 0) +
      (profileClicks ?? 0) +
      (urlClicks ?? 0),
  };
}

function rates(metric: PostMetricRecord) {
  const divide = (value: number | null, denominator: number | null) =>
    value === null || denominator === null || denominator <= 0 ? null : round(value / denominator);
  return {
    engagement_rate: divide(metric.total_engagements, metric.impressions),
    like_rate: divide(metric.likes, metric.impressions),
    reply_rate: divide(metric.replies, metric.impressions),
    repost_rate: divide(metric.reposts, metric.impressions),
    click_through_rate: divide(metric.url_clicks, metric.impressions),
    profile_visit_rate: divide(metric.profile_clicks, metric.impressions),
  };
}

export class ConnectionService {
  constructor(
    private readonly repository: Repository,
    private readonly vault: CredentialVault,
    private readonly client: XClient,
    private readonly env: Pick<
      Env,
      "SYNC_POST_LIMIT" | "X_CLIENT_ID" | "X_CLIENT_SECRET" | "CACHE_TTL_SECONDS"
    >,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async list(): Promise<SafeConnection[]> {
    return (await this.repository.listConnections()).map(safe);
  }

  async get(id: string): Promise<SafeConnection> {
    const record = await this.repository.getConnection(id);
    if (!record) throw notFound(`No connection with id "${id}".`);
    return safe(record);
  }

  async create(input: NewConnectionInput): Promise<SafeConnection> {
    this.validateInput(input);
    const user = await this.client.getAuthenticatedUser(input.access_token);
    const duplicate = (await this.repository.listConnections()).find(
      (item) => item.x_account_id === user.id,
    );
    if (duplicate) {
      // OAuth reconnection is deliberately idempotent. X has already told us
      // that these fresh credentials belong to this exact account, so replace
      // only the encrypted credential payload and retain all existing history.
      return this.replaceCredentials(duplicate.id, input);
    }
    const now = this.now().toISOString();
    const secretReference = await this.vault.store({
      access_token: input.access_token,
      refresh_token: input.refresh_token,
      token_type: input.token_type,
      scope: input.scope,
    });
    const record: ConnectionRecord = {
      id: `x-${randomUUID()}`,
      platform: "x",
      x_account_id: user.id,
      username: user.username,
      display_name: user.name,
      profile_image_url: user.profile_image_url ?? null,
      credential_secret_reference: secretReference,
      connection_status: "connected",
      token_expires_at: input.token_expires_at ?? null,
      last_synced_at: null,
      last_error: null,
      created_at: now,
      updated_at: now,
    };
    await this.repository.saveConnection(record);
    await this.sync(record.id, user);
    return this.get(record.id);
  }

  private validateInput(input: NewConnectionInput): void {
    if (!input.access_token?.trim())
      throw new ApiError(400, "bad_request", "access_token is required.");
    const scopes = new Set((input.scope ?? "").split(/[ ,]+/).filter(Boolean));
    const writeScopes = [...scopes].filter((scope) => scope.includes("write"));
    if (writeScopes.length > 0) {
      throw new ApiError(400, "bad_request", "Only read-only X scopes are accepted.", {
        rejected_scopes: writeScopes,
      });
    }
  }

  async replaceCredentials(id: string, input: NewConnectionInput): Promise<SafeConnection> {
    this.validateInput(input);
    const record = await this.require(id);
    const user = await this.client.getAuthenticatedUser(input.access_token);
    if (user.id !== record.x_account_id) {
      throw new ApiError(
        409,
        "account_mismatch",
        `These credentials belong to @${user.username}, not @${record.username}.`,
      );
    }
    await this.vault.store(
      {
        access_token: input.access_token,
        refresh_token: input.refresh_token,
        token_type: input.token_type,
        scope: input.scope,
      },
      record.credential_secret_reference,
    );
    record.token_expires_at = input.token_expires_at ?? null;
    record.connection_status = "connected";
    record.last_error = null;
    record.updated_at = this.now().toISOString();
    await this.repository.saveConnection(record);
    await this.sync(id, user);
    return this.get(id);
  }

  async test(id: string): Promise<SafeConnection> {
    const record = await this.require(id);
    try {
      const user = await this.client.getAuthenticatedUser(
        (await this.vault.read(record.credential_secret_reference)).access_token,
      );
      if (user.id !== record.x_account_id) {
        throw new ApiError(
          409,
          "account_mismatch",
          "The credentials now belong to a different X account.",
        );
      }
      Object.assign(record, {
        username: user.username,
        display_name: user.name,
        profile_image_url: user.profile_image_url ?? null,
        connection_status: "connected" as const,
        last_error: null,
        updated_at: this.now().toISOString(),
      });
    } catch (error) {
      record.connection_status = "disconnected";
      record.last_error = error instanceof Error ? error.message : "Credential validation failed.";
      record.updated_at = this.now().toISOString();
      await this.repository.saveConnection(record);
      throw error;
    }
    await this.repository.saveConnection(record);
    return safe(record);
  }

  async refresh(id: string): Promise<SafeConnection> {
    const record = await this.require(id);
    const credentials = await this.vault.read(record.credential_secret_reference);
    if (!credentials.refresh_token || !this.env.X_CLIENT_ID) {
      throw new ApiError(
        400,
        "refresh_unavailable",
        "This connection has no refresh token or X_CLIENT_ID.",
      );
    }
    const refreshed = await this.client.refreshAccessToken({
      refreshToken: credentials.refresh_token,
      clientId: this.env.X_CLIENT_ID,
      clientSecret: this.env.X_CLIENT_SECRET,
    });
    const next: XCredentials = {
      access_token: refreshed.access_token,
      refresh_token: refreshed.refresh_token ?? credentials.refresh_token,
      token_type: refreshed.token_type,
      scope: refreshed.scope,
    };
    await this.vault.store(next, record.credential_secret_reference);
    record.token_expires_at = refreshed.expires_in
      ? new Date(this.now().getTime() + refreshed.expires_in * 1000).toISOString()
      : null;
    record.connection_status = "connected";
    record.last_error = null;
    record.updated_at = this.now().toISOString();
    await this.repository.saveConnection(record);
    return this.test(id);
  }

  async delete(id: string): Promise<void> {
    if (!(await this.repository.deleteConnection(id))) {
      throw notFound(`No connection with id "${id}".`);
    }
  }

  private async require(account: string): Promise<ConnectionRecord> {
    const record =
      (await this.repository.getConnection(account)) ??
      (await this.repository.findConnectionByAccountId(account));
    if (!record) throw notFound(`No X account or connection matching "${account}".`);
    return record;
  }

  private async credentials(record: ConnectionRecord): Promise<XCredentials> {
    if (record.token_expires_at && Date.parse(record.token_expires_at) <= this.now().getTime()) {
      const credentials = await this.vault.read(record.credential_secret_reference);
      if (!credentials.refresh_token) {
        record.connection_status = "expired";
        record.last_error = "Access token expired and no refresh token is available.";
        await this.repository.saveConnection(record);
        throw new ApiError(502, "upstream_unauthorized", record.last_error);
      }
      await this.refresh(record.id);
    }
    return this.vault.read(record.credential_secret_reference);
  }

  async sync(
    account: string,
    knownUser?: XUser,
    refreshAttempted = false,
  ): Promise<SafeConnection> {
    const record = await this.require(account);
    try {
      const credentials = await this.credentials(record);
      const user = knownUser ?? (await this.client.getAuthenticatedUser(credentials.access_token));
      if (user.id !== record.x_account_id)
        throw new ApiError(409, "account_mismatch", "Credential/account mismatch.");
      const { tweets, media } = await this.client.getUserTweets(user.id, credentials.access_token, {
        maxResults: this.env.SYNC_POST_LIMIT,
      });
      await this.persistSnapshot(record, user, tweets, media);
      Object.assign(record, {
        username: user.username,
        display_name: user.name,
        profile_image_url: user.profile_image_url ?? null,
        connection_status: "connected" as const,
        last_synced_at: this.now().toISOString(),
        last_error: null,
        updated_at: this.now().toISOString(),
      });
      await this.repository.saveConnection(record);
      return safe(record);
    } catch (error) {
      if (
        !refreshAttempted &&
        error instanceof ApiError &&
        error.code === "upstream_unauthorized"
      ) {
        const credentials = await this.vault.read(record.credential_secret_reference);
        if (credentials.refresh_token && this.env.X_CLIENT_ID) {
          await this.refresh(record.id);
          return this.sync(record.id, undefined, true);
        }
      }
      record.connection_status =
        error instanceof ApiError && error.code === "upstream_unauthorized"
          ? "disconnected"
          : "error";
      record.last_error = error instanceof Error ? error.message : "Sync failed.";
      record.updated_at = this.now().toISOString();
      await this.repository.saveConnection(record);
      throw error;
    }
  }

  private async persistSnapshot(
    record: ConnectionRecord,
    user: XUser,
    tweets: XTweet[],
    media: XMedia[],
  ): Promise<void> {
    const capturedAt = this.now().toISOString();
    const mediaByKey = new Map(media.map((item) => [item.media_key, item.type]));
    const posts: PostRecord[] = tweets.map((tweet) => {
      const references = new Set(tweet.referenced_tweets?.map((item) => item.type));
      const urls = (tweet.entities?.urls ?? [])
        .map((item) => item.expanded_url ?? item.url)
        .filter((item): item is string => Boolean(item));
      return {
        account_id: record.x_account_id,
        post_id: tweet.id,
        text: tweet.text,
        created_at: tweet.created_at ?? null,
        url: `https://x.com/${user.username}/status/${tweet.id}`,
        lang: tweet.lang ?? null,
        kind: classifyTweet(tweet),
        is_reply: references.has("replied_to"),
        is_quote: references.has("quoted"),
        is_repost: references.has("retweeted"),
        media_types: [
          ...new Set(
            (tweet.attachments?.media_keys ?? [])
              .map((key) => mediaByKey.get(key))
              .filter((item): item is string => Boolean(item)),
          ),
        ],
        contains_url: urls.length > 0 || /https?:\/\//i.test(tweet.text),
        urls,
        hashtags: (tweet.entities?.hashtags ?? []).map((item) => item.tag),
        mentions: (tweet.entities?.mentions ?? []).map((item) => item.username),
        conversation_id: tweet.conversation_id ?? null,
        possibly_sensitive: tweet.possibly_sensitive ?? null,
        first_seen_at: capturedAt,
        updated_at: capturedAt,
      };
    });
    const metrics: PostMetricRecord[] = tweets.map((tweet) => ({
      account_id: record.x_account_id,
      post_id: tweet.id,
      captured_at: capturedAt,
      age_seconds: tweet.created_at
        ? Math.max(0, Math.floor((this.now().getTime() - Date.parse(tweet.created_at)) / 1000))
        : null,
      ...metricValue(tweet),
    }));
    const account: AccountSnapshotRecord = {
      account_id: record.x_account_id,
      captured_at: capturedAt,
      followers: user.public_metrics?.followers_count ?? null,
      following: user.public_metrics?.following_count ?? null,
      total_posts: user.public_metrics?.tweet_count ?? null,
      listed: user.public_metrics?.listed_count ?? null,
    };
    await this.repository.saveSnapshot(account, posts, metrics);
  }

  private async ensureFresh(record: ConnectionRecord): Promise<void> {
    const age = record.last_synced_at
      ? this.now().getTime() - Date.parse(record.last_synced_at)
      : Infinity;
    if (age >= this.env.CACHE_TTL_SECONDS * 1000) await this.sync(record.id);
  }

  async accountAnalytics(account: string, days = 30) {
    const record = await this.require(account);
    await this.ensureFresh(record);
    const since = this.now().getTime() - days * DAY;
    const history = (await this.repository.accountSnapshots(record.x_account_id)).filter(
      (item) => Date.parse(item.captured_at) >= since,
    );
    const current = history.at(-1) ?? null;
    const previous = history.length > 1 ? history[0]! : null;
    return {
      account: safe(await this.require(record.id)),
      current,
      follower_growth:
        current && previous && current.followers !== null && previous.followers !== null
          ? current.followers - previous.followers
          : null,
      history,
      generated_at: this.now().toISOString(),
    };
  }

  async posts(account: string, days = 30) {
    const record = await this.require(account);
    await this.ensureFresh(record);
    const since = this.now().getTime() - days * DAY;
    const posts = (await this.repository.posts(record.x_account_id)).filter(
      (post) => !post.created_at || Date.parse(post.created_at) >= since,
    );
    const latestMetricPromises = posts.map(async (post) =>
      (await this.repository.postMetrics(record.x_account_id, post.post_id)).at(-1),
    );
    const allLatest = (await Promise.all(latestMetricPromises)).filter(
      (item): item is PostMetricRecord => Boolean(item),
    );
    const recentAverage = allLatest.length
      ? allLatest.reduce((sum, item) => sum + (item.total_engagements ?? 0), 0) / allLatest.length
      : null;
    return {
      account: safe(await this.require(record.id)),
      days,
      count: posts.length,
      posts: await Promise.all(
        posts.map(async (post) => {
          const metric =
            (await this.repository.postMetrics(record.x_account_id, post.post_id)).at(-1) ?? null;
          return {
            ...post,
            metrics: metric ? { ...metric, ...rates(metric) } : null,
            performance_relative_to_recent_average:
              metric?.total_engagements !== null &&
              metric?.total_engagements !== undefined &&
              recentAverage &&
              recentAverage > 0
                ? round(metric.total_engagements / recentAverage)
                : null,
          };
        }),
      ),
      generated_at: this.now().toISOString(),
    };
  }

  async post(account: string, postId: string) {
    const record = await this.require(account);
    await this.ensureFresh(record);
    const post = await this.repository.post(record.x_account_id, postId);
    if (!post) throw notFound(`Post ${postId} was not found for @${record.username}.`);
    const history = await this.repository.postMetrics(record.x_account_id, postId);
    const milestones = Object.fromEntries(
      MILESTONES.map((target, index) => {
        const candidates = history.filter((item) => item.age_seconds !== null);
        const nearest =
          candidates
            .filter((item) => item.age_seconds! >= target)
            .sort((a, b) => a.age_seconds! - b.age_seconds!)[0] ?? null;
        return [MILESTONE_NAMES[index], nearest];
      }),
    );
    const latest = history.at(-1) ?? null;
    return {
      account: safe(await this.require(record.id)),
      post,
      metrics: latest ? { ...latest, ...rates(latest) } : null,
      metric_history: history,
      milestone_snapshots: milestones,
    };
  }

  async summary(account: string, days = 7) {
    const payload = await this.posts(account, Math.max(days, 60));
    const now = this.now().getTime();
    const aggregate = (from: number, to: number) => {
      const selected = payload.posts.filter(
        (item) =>
          item.created_at &&
          Date.parse(item.created_at) >= from &&
          Date.parse(item.created_at) < to,
      );
      const engagements = selected.map((item) => item.metrics?.total_engagements ?? 0);
      const total = engagements.reduce((sum, value) => sum + value, 0);
      return {
        posts: selected.length,
        total_engagements: total,
        average_engagements: selected.length ? round(total / selected.length) : 0,
      };
    };
    const period = (length: number) => ({
      current: aggregate(now - length * DAY, now + 1),
      previous: aggregate(now - length * 2 * DAY, now - length * DAY),
    });
    const selected = payload.posts.filter(
      (item) => item.created_at && Date.parse(item.created_at) >= now - days * DAY,
    );
    const ranked = selected
      .slice()
      .sort((a, b) => (b.metrics?.total_engagements ?? 0) - (a.metrics?.total_engagements ?? 0));
    const group = (key: (post: (typeof selected)[number]) => string[]) => {
      const output: Record<
        string,
        { posts: number; total_engagements: number; average_engagements: number }
      > = {};
      for (const post of selected)
        for (const name of key(post)) {
          const item = output[name] ?? { posts: 0, total_engagements: 0, average_engagements: 0 };
          item.posts += 1;
          item.total_engagements += post.metrics?.total_engagements ?? 0;
          output[name] = item;
        }
      for (const item of Object.values(output))
        item.average_engagements = item.posts ? round(item.total_engagements / item.posts) : 0;
      return output;
    };
    const accountHistory = await this.repository.accountSnapshots(payload.account.x_account_id);
    const latestFollowers = accountHistory.at(-1)?.followers ?? null;
    const baseline =
      accountHistory.filter((item) => Date.parse(item.captured_at) <= now - days * DAY).at(-1)
        ?.followers ?? null;
    return {
      account: payload.account,
      days,
      comparisons: {
        today_vs_yesterday: period(1),
        last_7_days_vs_previous_7: period(7),
        last_30_days_vs_previous_30: period(30),
      },
      average_performance: aggregate(now - days * DAY, now + 1),
      best_posts: ranked.slice(0, 5),
      worst_posts: ranked.slice(-5).reverse(),
      follower_growth:
        latestFollowers !== null && baseline !== null ? latestFollowers - baseline : null,
      format_performance: group((post) => [
        post.kind,
        ...(post.media_types.length ? post.media_types : ["text"]),
        post.contains_url ? "contains_url" : "no_url",
      ]),
      topic_performance: group((post) =>
        post.hashtags.length ? post.hashtags.map((tag) => `#${tag.toLowerCase()}`) : ["untagged"],
      ),
      generated_at: this.now().toISOString(),
    };
  }
}
