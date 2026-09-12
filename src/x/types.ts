/** Subset of the X API v2 payloads this service reads. */

export interface XUserPublicMetrics {
  followers_count: number;
  following_count: number;
  tweet_count: number;
  listed_count: number;
  like_count?: number;
}

export interface XUser {
  id: string;
  name: string;
  username: string;
  created_at?: string;
  description?: string;
  location?: string;
  profile_image_url?: string;
  protected?: boolean;
  url?: string;
  verified?: boolean;
  verified_type?: string;
  public_metrics?: XUserPublicMetrics;
}

export interface XTweetPublicMetrics {
  retweet_count: number;
  reply_count: number;
  like_count: number;
  quote_count: number;
  bookmark_count?: number;
  /** Only returned for tweets owned by the authenticating user. */
  impression_count?: number;
}

export type XReferencedTweetType = "retweeted" | "quoted" | "replied_to";

export interface XReferencedTweet {
  type: XReferencedTweetType;
  id: string;
}

export interface XTweet {
  id: string;
  text: string;
  created_at?: string;
  lang?: string;
  public_metrics?: XTweetPublicMetrics;
  referenced_tweets?: XReferencedTweet[];
}

export interface XTweetsPage {
  tweets: XTweet[];
  resultCount: number;
}
