import { describe, expect, it } from "vitest";
import { buildAccountAnalytics, classifyTweet } from "../src/x/analytics.js";
import type { XAccountConfig } from "../src/config/accounts.js";
import { sampleTweets, sampleUser } from "./fixtures/xApi.js";

const account: XAccountConfig = {
  id: "sample",
  label: "Sample",
  username: "sampleaccount",
  bearerToken: "token-should-never-be-exposed",
};

const NOW = new Date("2026-09-12T00:00:00.000Z");

function build(tweets = sampleTweets) {
  return buildAccountAnalytics({
    account,
    user: sampleUser,
    tweets,
    topTweetsCount: 3,
    now: NOW,
  });
}

describe("classifyTweet", () => {
  it("treats a post with no references as original", () => {
    expect(classifyTweet({ id: "1", text: "hello" })).toBe("original");
  });

  it("prefers the most specific relationship when several are present", () => {
    expect(
      classifyTweet({
        id: "1",
        text: "hello",
        referenced_tweets: [
          { type: "replied_to", id: "2" },
          { type: "retweeted", id: "3" },
        ],
      }),
    ).toBe("retweet");

    expect(
      classifyTweet({
        id: "1",
        text: "hello",
        referenced_tweets: [
          { type: "replied_to", id: "2" },
          { type: "quoted", id: "3" },
        ],
      }),
    ).toBe("quote");
  });
});

describe("buildAccountAnalytics", () => {
  it("never leaks the account's bearer token", () => {
    expect(JSON.stringify(build())).not.toContain("token-should-never-be-exposed");
  });

  it("reports the account identity and profile", () => {
    const analytics = build();
    expect(analytics.account).toEqual({ id: "sample", label: "Sample", username: "sampleaccount" });
    expect(analytics.profile.x_user_id).toBe("1234567890");
    expect(analytics.profile.name).toBe("Sample Account");
    expect(analytics.profile.account_age_days).toBeGreaterThan(2300);
  });

  it("derives audience figures from the user's public metrics", () => {
    const { audience, lifetime } = build();
    expect(audience).toEqual({
      followers: 1000,
      following: 250,
      follower_following_ratio: 4,
      listed: 42,
    });
    expect(lifetime).toEqual({ tweets: 5000, likes_given: 8000 });
  });

  it("sums engagement across the analysed window", () => {
    const { engagement } = build();
    expect(engagement.totals).toEqual({
      likes: 130,
      retweets: 63,
      replies: 6,
      quotes: 3,
      bookmarks: 4,
      impressions: null,
      engagements: 206,
    });
    expect(engagement.averages_per_tweet).toEqual({
      likes: 32.5,
      retweets: 15.75,
      replies: 1.5,
      quotes: 0.75,
      bookmarks: 1,
      impressions: null,
      engagements: 51.5,
    });
  });

  it("falls back to a per-follower engagement rate when impressions are hidden", () => {
    const { engagement, notes } = build();
    expect(engagement.engagement_rate_per_impression).toBeNull();
    expect(engagement.engagement_rate_per_follower).toBe(0.0515);
    expect(notes.join(" ")).toContain("Impression counts are not available");
  });

  it("uses impressions for the engagement rate when the credentials expose them", () => {
    const withImpressions = sampleTweets.map((tweet) => ({
      ...tweet,
      public_metrics: { ...tweet.public_metrics!, impression_count: 1000 },
    }));

    const { engagement, notes } = build(withImpressions);
    expect(engagement.totals.impressions).toBe(4000);
    expect(engagement.averages_per_tweet.impressions).toBe(1000);
    // 206 engagements / 4000 impressions
    expect(engagement.engagement_rate_per_impression).toBe(0.0515);
    expect(notes.join(" ")).not.toContain("Impression counts are not available");
  });

  it("flags a window where impressions cover only some posts", () => {
    const partial = sampleTweets.map((tweet, index) =>
      index === 0
        ? { ...tweet, public_metrics: { ...tweet.public_metrics!, impression_count: 500 } }
        : tweet,
    );

    const { engagement, notes } = build(partial);
    expect(engagement.totals.impressions).toBe(500);
    expect(notes.join(" ")).toContain("cover only 1 of 4");
  });

  it("breaks the window down by post kind", () => {
    expect(build().composition).toEqual({
      original: { count: 1, share: 0.25 },
      reply: { count: 1, share: 0.25 },
      retweet: { count: 1, share: 0.25 },
      quote: { count: 1, share: 0.25 },
    });
  });

  it("describes the analysed window and posting cadence in UTC", () => {
    const { window, cadence } = build();
    expect(window).toEqual({
      tweets_analyzed: 4,
      oldest_tweet_at: "2026-09-01T10:00:00.000Z",
      newest_tweet_at: "2026-09-04T10:00:00.000Z",
      days_covered: 3,
    });
    expect(cadence.tweets_per_day).toBe(1.33);
    expect(cadence.busiest_hour_utc).toBe(10);
    expect(cadence.busiest_weekday_utc).toBe("Tuesday");
    expect(cadence.by_hour_utc["10:00"]).toBe(3);
    expect(cadence.by_hour_utc["14:00"]).toBe(1);
    expect(cadence.by_hour_utc["03:00"]).toBe(0);
    expect(Object.keys(cadence.by_hour_utc)).toHaveLength(24);
    // Hour keys must stay in chronological order in the JSON response.
    expect(Object.keys(cadence.by_hour_utc).slice(0, 3)).toEqual(["00:00", "01:00", "02:00"]);
    expect(cadence.by_weekday_utc["Tuesday"]).toBe(1);
    expect(cadence.by_weekday_utc["Sunday"]).toBe(0);
  });

  it("ranks top posts by engagement and links them", () => {
    const { top_tweets } = build();
    expect(top_tweets.map((tweet) => tweet.id)).toEqual(["101", "103", "104"]);
    expect(top_tweets[0]!.engagements).toBe(120);
    expect(top_tweets[0]!.url).toBe("https://x.com/sampleaccount/status/101");
    expect(top_tweets[0]!.kind).toBe("original");
    // Whitespace in the source text is collapsed for the preview.
    expect(top_tweets[0]!.text_preview).toBe("An original post about shipping things.");
  });

  it("handles an account with no visible posts without dividing by zero", () => {
    const analytics = build([]);
    expect(analytics.window.tweets_analyzed).toBe(0);
    expect(analytics.window.days_covered).toBeNull();
    expect(analytics.engagement.totals.engagements).toBe(0);
    expect(analytics.engagement.averages_per_tweet.engagements).toBe(0);
    expect(analytics.engagement.engagement_rate_per_follower).toBeNull();
    expect(analytics.cadence.tweets_per_day).toBeNull();
    expect(analytics.cadence.busiest_hour_utc).toBeNull();
    expect(analytics.cadence.busiest_weekday_utc).toBeNull();
    expect(analytics.top_tweets).toEqual([]);
    expect(analytics.notes.join(" ")).toContain("no posts visible");
  });

  it("omits a per-day rate for a window shorter than a day", () => {
    const sameDay = [
      sampleTweets[0]!,
      { ...sampleTweets[1]!, created_at: "2026-09-01T12:00:00.000Z" },
    ];
    expect(build(sameDay).cadence.tweets_per_day).toBeNull();
  });

  it("treats missing public metrics as zero rather than failing", () => {
    const analytics = build([
      { id: "1", text: "no metrics", created_at: "2026-09-01T10:00:00.000Z" },
    ]);
    expect(analytics.engagement.totals.engagements).toBe(0);
    expect(analytics.top_tweets[0]!.likes).toBe(0);
  });
});
