export type ConnectionStatus = "connected" | "disconnected" | "expired" | "error";

export interface StoredSecret {
  id: string;
  algorithm: "aes-256-gcm";
  iv: string;
  auth_tag: string;
  ciphertext: string;
  created_at: string;
  updated_at: string;
}

export interface ConnectionRecord {
  id: string;
  platform: "x";
  x_account_id: string;
  username: string;
  display_name: string;
  profile_image_url: string | null;
  credential_secret_reference: string;
  connection_status: ConnectionStatus;
  token_expires_at: string | null;
  last_synced_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface AccountSnapshotRecord {
  account_id: string;
  captured_at: string;
  followers: number | null;
  following: number | null;
  total_posts: number | null;
  listed: number | null;
}

export interface PostRecord {
  account_id: string;
  post_id: string;
  text: string;
  created_at: string | null;
  url: string;
  lang: string | null;
  kind: "original" | "reply" | "retweet" | "quote";
  is_reply: boolean;
  is_quote: boolean;
  is_repost: boolean;
  media_types: string[];
  contains_url: boolean;
  urls: string[];
  hashtags: string[];
  mentions: string[];
  conversation_id: string | null;
  possibly_sensitive: boolean | null;
  first_seen_at: string;
  updated_at: string;
}

export interface PostMetricRecord {
  account_id: string;
  post_id: string;
  captured_at: string;
  age_seconds: number | null;
  impressions: number | null;
  likes: number;
  replies: number;
  reposts: number;
  quotes: number;
  bookmarks: number | null;
  profile_clicks: number | null;
  url_clicks: number | null;
  user_profile_clicks: number | null;
  total_engagements: number | null;
}

/** One-time OAuth state. The matching PKCE verifier is encrypted in secrets. */
export interface OAuthStateRecord {
  state: string;
  verifier_secret_reference: string;
  expires_at: string;
  created_at: string;
}

export interface PersistentState {
  version: 1;
  connections: ConnectionRecord[];
  secrets: StoredSecret[];
  account_snapshots: AccountSnapshotRecord[];
  posts: PostRecord[];
  post_metrics: PostMetricRecord[];
  oauth_states: OAuthStateRecord[];
}
