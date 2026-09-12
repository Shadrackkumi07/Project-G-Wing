import type { PublicXAccount, XAccountConfig } from "../config/accounts.js";
import { toPublicAccount } from "../config/accounts.js";
import type { XTweet, XUser } from "./types.js";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MS_PER_DAY = 86_400_000;
const TEXT_PREVIEW_LIMIT = 280;

export type TweetKind = "original" | "reply" | "retweet" | "quote";

export interface MetricTotals {
  likes: number;
  retweets: number;
  replies: number;
  quotes: number;
  bookmarks: number;
  /** Null when the credentials cannot see impression counts. */
  impressions: number | null;
  engagements: number;
}

export interface CompositionSlice {
  count: number;
  /** Share of the analysed window, 0–1. */
  share: number;
}

export interface TopTweet {
  id: string;
  url: string;
  created_at: string | null;
  text_preview: string;
  kind: TweetKind;
  likes: number;
  retweets: number;
  replies: number;
  quotes: number;
  bookmarks: number;
  impressions: number | null;
  engagements: number;
}

export interface AccountAnalytics {
  account: PublicXAccount;
  profile: {
    x_user_id: string;
    username: string;
    name: string;
    description: string | null;
    location: string | null;
    website: string | null;
    profile_image_url: string | null;
    joined_at: string | null;
    account_age_days: number | null;
    protected: boolean | null;
    verified: boolean | null;
    verified_type: string | null;
  };
  audience: {
    followers: number | null;
    following: number | null;
    follower_following_ratio: number | null;
    listed: number | null;
  };
  lifetime: {
    tweets: number | null;
    likes_given: number | null;
  };
  window: {
    tweets_analyzed: number;
    oldest_tweet_at: string | null;
    newest_tweet_at: string | null;
    days_covered: number | null;
  };
  engagement: {
    totals: MetricTotals;
    averages_per_tweet: MetricTotals;
    engagement_rate_per_impression: number | null;
    engagement_rate_per_follower: number | null;
  };
  composition: Record<TweetKind, CompositionSlice>;
  cadence: {
    tweets_per_day: number | null;
    busiest_hour_utc: number | null;
    busiest_weekday_utc: string | null;
    by_hour_utc: Record<string, number>;
    by_weekday_utc: Record<string, number>;
  };
  top_tweets: TopTweet[];
  notes: string[];
  generated_at: string;
  source: "x-api-v2";
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function ratio(numerator: number, denominator: number | null | undefined): number | null {
  if (denominator === null || denominator === undefined || denominator <= 0) return null;
  return round(numerator / denominator, 4);
}

/**
 * A tweet can carry several references at once (a quote that is also a reply),
 * so the most specific relationship wins in this order.
 */
export function classifyTweet(tweet: XTweet): TweetKind {
  const types = new Set(tweet.referenced_tweets?.map((reference) => reference.type));
  if (types.has("retweeted")) return "retweet";
  if (types.has("quoted")) return "quote";
  if (types.has("replied_to")) return "reply";
  return "original";
}

function tweetMetrics(tweet: XTweet) {
  const metrics = tweet.public_metrics;
  const likes = metrics?.like_count ?? 0;
  const retweets = metrics?.retweet_count ?? 0;
  const replies = metrics?.reply_count ?? 0;
  const quotes = metrics?.quote_count ?? 0;
  const bookmarks = metrics?.bookmark_count ?? 0;
  const impressions = metrics?.impression_count;

  return {
    likes,
    retweets,
    replies,
    quotes,
    bookmarks,
    impressions: typeof impressions === "number" ? impressions : null,
    engagements: likes + retweets + replies + quotes + bookmarks,
  };
}

function hourKey(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`;
}

function preview(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > TEXT_PREVIEW_LIMIT
    ? `${collapsed.slice(0, TEXT_PREVIEW_LIMIT - 1)}…`
    : collapsed;
}

function parseTimestamp(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

export interface BuildAnalyticsInput {
  account: XAccountConfig;
  user: XUser;
  tweets: XTweet[];
  topTweetsCount: number;
  now?: Date;
}

export function buildAccountAnalytics({
  account,
  user,
  tweets,
  topTweetsCount,
  now = new Date(),
}: BuildAnalyticsInput): AccountAnalytics {
  const notes: string[] = [];
  const userMetrics = user.public_metrics;
  const followers = userMetrics?.followers_count ?? null;
  const following = userMetrics?.following_count ?? null;

  const enriched = tweets.map((tweet) => ({
    tweet,
    kind: classifyTweet(tweet),
    metrics: tweetMetrics(tweet),
    timestamp: parseTimestamp(tweet.created_at),
  }));

  const totals: MetricTotals = {
    likes: 0,
    retweets: 0,
    replies: 0,
    quotes: 0,
    bookmarks: 0,
    impressions: null,
    engagements: 0,
  };

  let impressionTotal = 0;
  let tweetsWithImpressions = 0;
  // Tracked separately so a partially-covered window divides engagements by the
  // impressions of the same posts, rather than the whole window's engagements
  // by a subset's impressions.
  let engagementsWithImpressions = 0;

  const byHour: Record<string, number> = {};
  const byWeekday: Record<string, number> = {};
  // "13:00" rather than "13": a purely numeric key would be reordered by the
  // JS integer-key rule, putting 10-23 ahead of 00-09 in the JSON response.
  for (let hour = 0; hour < 24; hour += 1) {
    byHour[hourKey(hour)] = 0;
  }
  for (const weekday of WEEKDAYS) {
    byWeekday[weekday] = 0;
  }

  const composition: Record<TweetKind, CompositionSlice> = {
    original: { count: 0, share: 0 },
    reply: { count: 0, share: 0 },
    retweet: { count: 0, share: 0 },
    quote: { count: 0, share: 0 },
  };

  let oldest: number | null = null;
  let newest: number | null = null;

  for (const { kind, metrics, timestamp } of enriched) {
    totals.likes += metrics.likes;
    totals.retweets += metrics.retweets;
    totals.replies += metrics.replies;
    totals.quotes += metrics.quotes;
    totals.bookmarks += metrics.bookmarks;
    totals.engagements += metrics.engagements;

    if (metrics.impressions !== null) {
      impressionTotal += metrics.impressions;
      tweetsWithImpressions += 1;
      engagementsWithImpressions += metrics.engagements;
    }

    composition[kind].count += 1;

    if (timestamp !== null) {
      const date = new Date(timestamp);
      const hour = hourKey(date.getUTCHours());
      byHour[hour] = (byHour[hour] ?? 0) + 1;
      const weekdayKey = WEEKDAYS[date.getUTCDay()] ?? "Unknown";
      byWeekday[weekdayKey] = (byWeekday[weekdayKey] ?? 0) + 1;

      oldest = oldest === null ? timestamp : Math.min(oldest, timestamp);
      newest = newest === null ? timestamp : Math.max(newest, timestamp);
    }
  }

  if (tweetsWithImpressions > 0) {
    totals.impressions = impressionTotal;
    if (tweetsWithImpressions < enriched.length) {
      notes.push(
        `Impressions cover only ${tweetsWithImpressions} of ${enriched.length} analysed posts; ` +
          `impression-based rates are calculated from those posts alone.`,
      );
    }
  } else if (enriched.length > 0) {
    notes.push(
      "Impression counts are not available for these credentials. X only returns " +
        "impression_count to a user-context token for the authenticated user's own posts, " +
        "so engagement rate falls back to a per-follower figure.",
    );
  }

  const analyzed = enriched.length;
  if (analyzed === 0) {
    notes.push("This account has no posts visible to the configured credentials.");
  }

  for (const kind of Object.keys(composition) as TweetKind[]) {
    composition[kind].share = analyzed > 0 ? round(composition[kind].count / analyzed, 4) : 0;
  }

  const perTweet = (total: number): number => (analyzed > 0 ? round(total / analyzed, 2) : 0);
  const averages: MetricTotals = {
    likes: perTweet(totals.likes),
    retweets: perTweet(totals.retweets),
    replies: perTweet(totals.replies),
    quotes: perTweet(totals.quotes),
    bookmarks: perTweet(totals.bookmarks),
    impressions:
      tweetsWithImpressions > 0 ? round(impressionTotal / tweetsWithImpressions, 2) : null,
    engagements: perTweet(totals.engagements),
  };

  const daysCovered =
    oldest !== null && newest !== null
      ? Math.max(round((newest - oldest) / MS_PER_DAY, 2), 0)
      : null;

  const busiestHourEntry = Object.entries(byHour).reduce<[string, number] | null>(
    (best, entry) => (best === null || entry[1] > best[1] ? entry : best),
    null,
  );
  const busiestWeekdayEntry = Object.entries(byWeekday).reduce<[string, number] | null>(
    (best, entry) => (best === null || entry[1] > best[1] ? entry : best),
    null,
  );

  const topTweets: TopTweet[] = enriched
    .slice()
    .sort(
      (a, b) =>
        b.metrics.engagements - a.metrics.engagements || b.tweet.id.localeCompare(a.tweet.id),
    )
    .slice(0, topTweetsCount)
    .map(({ tweet, kind, metrics }) => ({
      id: tweet.id,
      url: `https://x.com/${user.username}/status/${tweet.id}`,
      created_at: tweet.created_at ?? null,
      text_preview: preview(tweet.text),
      kind,
      ...metrics,
    }));

  const joinedAt = parseTimestamp(user.created_at);

  return {
    account: toPublicAccount(account),
    profile: {
      x_user_id: user.id,
      username: user.username,
      name: user.name,
      description: user.description ?? null,
      location: user.location ?? null,
      website: user.url ?? null,
      profile_image_url: user.profile_image_url ?? null,
      joined_at: user.created_at ?? null,
      account_age_days:
        joinedAt !== null ? Math.max(Math.floor((now.getTime() - joinedAt) / MS_PER_DAY), 0) : null,
      protected: user.protected ?? null,
      verified: user.verified ?? null,
      verified_type: user.verified_type ?? null,
    },
    audience: {
      followers,
      following,
      follower_following_ratio: followers !== null ? ratio(followers, following) : null,
      listed: userMetrics?.listed_count ?? null,
    },
    lifetime: {
      tweets: userMetrics?.tweet_count ?? null,
      likes_given: userMetrics?.like_count ?? null,
    },
    window: {
      tweets_analyzed: analyzed,
      oldest_tweet_at: oldest !== null ? new Date(oldest).toISOString() : null,
      newest_tweet_at: newest !== null ? new Date(newest).toISOString() : null,
      days_covered: daysCovered,
    },
    engagement: {
      totals,
      averages_per_tweet: averages,
      engagement_rate_per_impression:
        tweetsWithImpressions > 0 ? ratio(engagementsWithImpressions, impressionTotal) : null,
      // With nothing analysed, a rate of 0 would read as "no engagement"
      // rather than "no data", so it is reported as unknown instead.
      engagement_rate_per_follower: analyzed > 0 ? ratio(averages.engagements, followers) : null,
    },
    composition,
    cadence: {
      // A window shorter than a day would inflate a per-day rate, so it is
      // reported only once the posts actually span at least one day.
      tweets_per_day:
        daysCovered !== null && daysCovered >= 1 ? round(analyzed / daysCovered, 2) : null,
      busiest_hour_utc:
        busiestHourEntry && busiestHourEntry[1] > 0
          ? Number(busiestHourEntry[0].slice(0, 2))
          : null,
      busiest_weekday_utc:
        busiestWeekdayEntry && busiestWeekdayEntry[1] > 0 ? busiestWeekdayEntry[0] : null,
      by_hour_utc: byHour,
      by_weekday_utc: byWeekday,
    },
    top_tweets: topTweets,
    notes,
    generated_at: now.toISOString(),
    source: "x-api-v2",
  };
}
