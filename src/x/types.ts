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

export interface XTweetPrivateMetrics {
  impression_count?: number;
  url_link_clicks?: number;
  user_profile_clicks?: number;
  like_count?: number;
  reply_count?: number;
  retweet_count?: number;
}

export interface XTweetOrganicMetrics extends XTweetPrivateMetrics {
  like_count?: number;
  reply_count?: number;
  retweet_count?: number;
}

export interface XEntitySet {
  urls?: Array<{ expanded_url?: string; url?: string }>;
  hashtags?: Array<{ tag: string }>;
  mentions?: Array<{ username: string }>;
}

export interface XMedia {
  media_key: string;
  type: "photo" | "video" | "animated_gif" | string;
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
  non_public_metrics?: XTweetPrivateMetrics;
  organic_metrics?: XTweetOrganicMetrics;
  referenced_tweets?: XReferencedTweet[];
  attachments?: { media_keys?: string[] };
  entities?: XEntitySet;
  conversation_id?: string;
  possibly_sensitive?: boolean;
}

export interface XTweetsPage {
  tweets: XTweet[];
  resultCount: number;
  media: XMedia[];
}
