import type { FetchLike } from "../../src/x/client.js";
import type { XTweet, XUser } from "../../src/x/types.js";

export const sampleUser: XUser = {
  id: "1234567890",
  name: "Sample Account",
  username: "sampleaccount",
  created_at: "2020-05-15T08:30:00.000Z",
  description: "A fixture account.",
  location: "Fargo, ND",
  url: "https://example.com",
  profile_image_url: "https://pbs.twimg.com/profile_images/sample.jpg",
  protected: false,
  verified: false,
  verified_type: "none",
  public_metrics: {
    followers_count: 1000,
    following_count: 250,
    tweet_count: 5000,
    listed_count: 42,
    like_count: 8000,
  },
};

/**
 * Four posts, one of each kind, with engagement totals that are easy to assert:
 * likes 130, retweets 63, replies 6, quotes 3, bookmarks 4 => 206 engagements.
 */
export const sampleTweets: XTweet[] = [
  {
    id: "101",
    text: "An original post about   shipping   things.",
    created_at: "2026-09-01T10:00:00.000Z",
    lang: "en",
    public_metrics: {
      like_count: 100,
      retweet_count: 10,
      reply_count: 5,
      quote_count: 2,
      bookmark_count: 3,
    },
  },
  {
    id: "102",
    text: "Replying to someone.",
    created_at: "2026-09-02T10:00:00.000Z",
    lang: "en",
    public_metrics: {
      like_count: 10,
      retweet_count: 1,
      reply_count: 0,
      quote_count: 0,
      bookmark_count: 0,
    },
    referenced_tweets: [{ type: "replied_to", id: "999" }],
  },
  {
    id: "103",
    text: "RT @someone: a boosted post.",
    created_at: "2026-09-03T14:00:00.000Z",
    lang: "en",
    public_metrics: {
      like_count: 0,
      retweet_count: 50,
      reply_count: 0,
      quote_count: 0,
      bookmark_count: 0,
    },
    referenced_tweets: [{ type: "retweeted", id: "888" }],
  },
  {
    id: "104",
    text: "Quoting with commentary.",
    created_at: "2026-09-04T10:00:00.000Z",
    lang: "en",
    public_metrics: {
      like_count: 20,
      retweet_count: 2,
      reply_count: 1,
      quote_count: 1,
      bookmark_count: 1,
    },
    // Also a reply: the quote relationship must win.
    referenced_tweets: [
      { type: "quoted", id: "777" },
      { type: "replied_to", id: "776" },
    ],
  },
];

export interface FakeFetchOptions {
  user?: XUser;
  tweets?: XTweet[];
  userStatus?: number;
  tweetsStatus?: number;
  errorBody?: unknown;
  headers?: Record<string, string>;
}

export interface FakeFetch {
  fetch: FetchLike;
  calls: string[];
}

export function createFakeFetch(options: FakeFetchOptions = {}): FakeFetch {
  const {
    user = sampleUser,
    tweets = sampleTweets,
    userStatus = 200,
    tweetsStatus = 200,
    errorBody = { title: "Unauthorized", detail: "Unauthorized" },
    headers = {},
  } = options;

  const calls: string[] = [];

  const fetch: FetchLike = async (url) => {
    calls.push(url);
    const json = (body: unknown, status: number) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json", ...headers },
      });

    if (url.includes("/users/by/username/")) {
      return userStatus === 200 ? json({ data: user }, 200) : json(errorBody, userStatus);
    }
    if (url.includes("/tweets")) {
      return tweetsStatus === 200
        ? json({ data: tweets, meta: { result_count: tweets.length } }, 200)
        : json(errorBody, tweetsStatus);
    }
    return json({ title: "Not Found" }, 404);
  };

  return { fetch, calls };
}
