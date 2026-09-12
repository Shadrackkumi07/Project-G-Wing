# Project G Wing

A persistent, read-only X analytics API designed for ChatGPT and other agents.
It keeps one shared X developer integration while storing each authorized X
account as an independent encrypted connection.

- **Read-only.** Nothing in this service can post, delete, follow, or change
  anything on X. It only reads.
- **Credentials stay server-side.** Per-account OAuth tokens are AES-256-GCM
  encrypted at rest and are never returned. Request headers and credential body
  fields are redacted from logs.
- **Identity is automatic.** Adding credentials calls X `/users/me`; the X
  account ID, handle, name, and profile image are detected rather than typed.
- **History is durable.** Account and post snapshots remain in `DATA_FILE`
  across restarts. The Render blueprint attaches a persistent disk.
- **Accounts never mix.** Every post and snapshot is keyed by X's immutable
  account ID, and replacement credentials must resolve to that same ID.
- **Two protected surfaces.** Admin routes require an `Authorization` API key;
  ChatGPT receives a separate URL token with GET-only access.

## Credential architecture

There are three different credential roles, and they never mix:

```
Admin ── API_KEY ──► this API ── account OAuth token ──► X API
ChatGPT ── URL token ──► sanitized read-only analytics
                              │
                              ├── one shared X_CLIENT_ID / X_CLIENT_SECRET
                              └── encrypted token per detected X account
```

A caller proves who it is with an API key you issue. `POST /v1/connections/x`
is an admin operation using that same protection. Use only read scopes:
`tweet.read users.read offline.access`; submitted write scopes are rejected.

ChatGPT has no access to `/v1`. Its only route is
`GET /api/chatgpt/{token}/{account}?days=30`; it returns safe analytics,
posts, and 7/30-day summaries only. URL tokens are redacted from application
logs and error messages.

## Endpoints

| Method   | Path                                 | Auth | Description                                                  |
| -------- | ------------------------------------ | ---- | ------------------------------------------------------------ |
| `GET`    | `/`                                  | No   | Index of available endpoints.                                |
| `GET`    | `/healthz`                           | No   | Liveness probe.                                              |
| `GET`    | `/openapi.json`                      | No   | OpenAPI 3.1 specification.                                   |
| `GET`    | `/docs`                              | No   | Interactive documentation.                                   |
| `GET`    | `/api/chatgpt/{token}/{account}`     | URL  | Sanitized, rate-limited GET-only ChatGPT analytics.          |
| `GET`    | `/v1/accounts`                       | Yes  | Legacy and connected accounts, independently identified.     |
| `GET`    | `/v1/accounts/{accountId}`           | Yes  | Profile and audience snapshot for one account.               |
| `GET`    | `/v1/accounts/{accountId}/analytics` | Yes  | Full analytics for one account.                              |
| `GET`    | `/v1/accounts/{accountId}/tweets`    | Yes  | The posts behind the window, with per-post metrics.          |
| `GET`    | `/v1/analytics`                      | Yes  | Full analytics for **every** account, reported separately.   |
| `POST`   | `/v1/oauth/x/authorize`              | Yes  | Create a one-time X OAuth URL for the signed-in X account.   |
| `POST`   | `/v1/connections/x`                  | Yes  | Validate a user token, detect its account, encrypt it, sync. |
| `GET`    | `/v1/connections`                    | Yes  | Connection identities and health; never credentials.         |
| `GET`    | `/v1/connections/{id}`               | Yes  | One safe connection record.                                  |
| `PUT`    | `/v1/connections/{id}`               | Yes  | Replace credentials after same-account validation.           |
| `POST`   | `/v1/connections/{id}/test`          | Yes  | Revalidate identity and health.                              |
| `POST`   | `/v1/connections/{id}/refresh`       | Yes  | Refresh OAuth credentials.                                   |
| `POST`   | `/v1/connections/{id}/sync`          | Yes  | Immediately capture a durable analytics snapshot.            |
| `DELETE` | `/v1/connections/{id}`               | Yes  | Remove connection and encrypted secret.                      |
| `GET`    | `/v1/analytics/{account}?days=30`    | Yes  | Account history and follower growth.                         |
| `GET`    | `/v1/posts/{account}?days=30`        | Yes  | Posts, current metrics, rates, and relative performance.     |
| `GET`    | `/v1/posts/{account}/{post_id}`      | Yes  | Full post and all age/milestone snapshots.                   |
| `GET`    | `/v1/summary/{account}?days=7`       | Yes  | Comparisons, averages, best/worst, topics, and formats.      |

For connected accounts, `{account}` accepts the connection ID, immutable X
account ID, or current handle. Prefer the X account ID so handle changes never
change URLs. Legacy environment slots remain supported for compatibility.

An agent can discover everything from `GET /` and `GET /openapi.json` without
being told the shape in advance.

### ChatGPT URL

Generate the URL token once and set it as `CHATGPT_ACCESS_TOKEN` on Render:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Then provide ChatGPT only this URL—not your admin API key or any X token:

```text
https://your-service.onrender.com/api/chatgpt/CHATGPT_ACCESS_TOKEN/123456789?days=30
```

### Example

```bash
curl -H "Authorization: Bearer $API_KEY" \
  https://your-service.onrender.com/v1/accounts/main/analytics
```

```jsonc
{
  "data": {
    "account": { "id": "main", "label": "Personal", "username": "sampleaccount" },
    "profile": {
      "x_user_id": "1234567890",
      "username": "sampleaccount",
      "name": "Sample Account",
      "description": "A fixture account.",
      "location": "Fargo, ND",
      "website": "https://example.com",
      "profile_image_url": "https://pbs.twimg.com/profile_images/sample.jpg",
      "joined_at": "2020-05-15T08:30:00.000Z",
      "account_age_days": 2310,
      "protected": false,
      "verified": false,
      "verified_type": "none",
    },
    "audience": {
      "followers": 1000,
      "following": 250,
      "follower_following_ratio": 4,
      "listed": 42,
    },
    "lifetime": { "tweets": 5000, "likes_given": 8000 },
    "window": {
      "tweets_analyzed": 4,
      "oldest_tweet_at": "2026-09-01T10:00:00.000Z",
      "newest_tweet_at": "2026-09-04T10:00:00.000Z",
      "days_covered": 3,
    },
    "engagement": {
      "totals": {
        "likes": 130,
        "retweets": 63,
        "replies": 6,
        "quotes": 3,
        "bookmarks": 4,
        "impressions": null,
        "engagements": 206,
      },
      "averages_per_tweet": {
        "likes": 32.5,
        "retweets": 15.75,
        "replies": 1.5,
        "quotes": 0.75,
        "bookmarks": 1,
        "impressions": null,
        "engagements": 51.5,
      },
      "engagement_rate_per_impression": null,
      "engagement_rate_per_follower": 0.0515,
    },
    "composition": {
      "original": { "count": 1, "share": 0.25 },
      "reply": { "count": 1, "share": 0.25 },
      "retweet": { "count": 1, "share": 0.25 },
      "quote": { "count": 1, "share": 0.25 },
    },
    "cadence": {
      "tweets_per_day": 1.33,
      "busiest_hour_utc": 10,
      "busiest_weekday_utc": "Tuesday",
      "by_hour_utc": { "00:00": 0, "01:00": 0, "10:00": 3, "14:00": 1 }, // all 24 hours present
      "by_weekday_utc": {
        "Sunday": 0,
        "Monday": 0,
        "Tuesday": 1,
        "Wednesday": 1,
        "Thursday": 1,
        "Friday": 1,
        "Saturday": 0,
      },
    },
    "top_tweets": [
      {
        "id": "101",
        "url": "https://x.com/sampleaccount/status/101",
        "created_at": "2026-09-01T10:00:00.000Z",
        "text_preview": "An original post about shipping things.",
        "kind": "original",
        "likes": 100,
        "retweets": 10,
        "replies": 5,
        "quotes": 2,
        "bookmarks": 3,
        "impressions": null,
        "engagements": 120,
      },
    ],
    "notes": [
      "Impression counts are not available for these credentials. X only returns impression_count to a user-context token for the authenticated user's own posts, so engagement rate falls back to a per-follower figure.",
    ],
    "generated_at": "2026-09-12T00:00:00.000Z",
    "source": "x-api-v2",
  },
  "meta": { "cached": false, "cache_age_seconds": 0, "cache_ttl_seconds": 300 },
}
```

### How the numbers are defined

- **engagements** = likes + retweets + replies + quotes + bookmarks.
- **window** is the most recent `ANALYTICS_TWEET_LIMIT` posts (default 100, X's
  per-page maximum) — not a fixed date range. `window` states exactly which
  posts were covered.
- **composition** classifies each post as `retweet` > `quote` > `reply` >
  `original`. A post can carry several relationships at once (a quote that is
  also a reply), so the most specific one wins.
- **cadence** is in UTC. `tweets_per_day` is omitted when the window spans less
  than a day, because a shorter span would inflate it.
- **`null` means unknown, not zero.** Anything X did not return is `null`, and
  `notes` explains why.
- **impressions** are only returned by X to a _user-context_ token for that
  user's own posts. With an app-only Bearer token they are `null` and
  `engagement_rate_per_impression` is `null` too;
  `engagement_rate_per_follower` is always available as a fallback.

### Errors

Every error uses the same envelope:

```json
{ "error": { "code": "not_found", "message": "…", "details": {} } }
```

| Status | `code`                  | Meaning                                           |
| ------ | ----------------------- | ------------------------------------------------- |
| 400    | `bad_request`           | Malformed request, e.g. an invalid account id.    |
| 401    | `unauthorized`          | API key missing or not recognised.                |
| 403    | `https_required`        | Request arrived over plaintext HTTP.              |
| 404    | `not_found`             | Unknown account id or route. Lists the valid ids. |
| 429    | `rate_limited`          | You exceeded this service's own rate limit.       |
| 429    | `upstream_rate_limited` | X's rate limit for your credentials is exhausted. |
| 502    | `upstream_unauthorized` | X rejected the configured credentials.            |
| 502    | `upstream_error`        | X returned an unexpected error.                   |
| 504    | `upstream_unavailable`  | X did not respond in time.                        |

`GET /v1/analytics` is the exception: one broken account must not hide the
others, so it returns 200 and marks that account `"status": "error"` inline.

## Connecting X accounts

Create one X developer application and set its client ID/secret once. In the X
Developer Portal, choose **Web App, Automated App or Bot** and enter these
values exactly:

| X setting                   | Value for this Render service                         |
| --------------------------- | ----------------------------------------------------- |
| Website URL                 | `https://project-g-wing.onrender.com`                 |
| Callback URI / Redirect URI | `https://project-g-wing.onrender.com/auth/x/callback` |

The callback is **not** `/auth/x`, does not contain an account ID, and must not
contain your ChatGPT URL token. Set the same callback as the Render environment
variable `X_OAUTH_REDIRECT_URI`. Request only `tweet.read users.read
offline.access` scopes. Do not request email unless you have an actual product
need and X's required legal URLs are configured.

After deployment, start the OAuth connection with your admin API key:

```bash
curl -X POST https://project-g-wing.onrender.com/v1/oauth/x/authorize \
  -H "Authorization: Bearer $API_KEY"
```

Open the returned `authorization_url` in a browser while signed into the X
account you want to add. X redirects back to `/auth/x/callback`; the service
exchanges the code, calls X `/2/users/me`, and saves the matching X account ID,
handle, display name, and encrypted per-account token automatically. Repeat
this for each X account. There is no account-ID entry step and no code change
needed for another account.

The direct-token admin route remains available if you already obtain a
user-context token another way:

```bash
curl -X POST https://your-service.example/v1/connections/x \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "access_token": "...",
    "refresh_token": "...",
    "token_expires_at": "2026-09-12T17:00:00Z",
    "scope": "tweet.read users.read offline.access"
  }'
```

The service immediately calls X `/users/me`, rejects invalid or duplicate
connections, saves the detected immutable X account ID, encrypts both tokens,
and performs the first sync. Repeat this request for every account—no source
code or manual handle mapping is needed.

### Historical field guide

- Connection records contain `id`, `platform`, `x_account_id`, `username`,
  `display_name`, `profile_image_url`, `connection_status`, `token_expires_at`,
  `last_synced_at`, `last_error`, `created_at`, and `updated_at`.
- Account snapshots contain `captured_at`, `followers`, `following`,
  `total_posts`, and `listed`.
- Stored posts preserve full `text`, `created_at`, canonical `url`, language,
  original/reply/quote/repost flags, media types, URL presence and expanded
  URLs, hashtags, mentions, conversation ID, and sensitivity flag.
- Every metric snapshot contains its capture time and post age plus
  impressions, likes, replies, reposts, quotes, bookmarks, profile clicks, URL
  clicks, and total engagements. Unavailable X metrics are `null`, never a
  fabricated zero.
- Derived post metrics include engagement, like, reply, repost, click-through,
  and profile-visit rates, plus performance relative to the account's recent
  average.
- Post detail selects the first stored snapshot at or after 1 hour, 6 hours, 24
  hours, 3 days, 7 days, and 30 days. All raw snapshots remain available too.
- Summaries include today/yesterday, rolling 7-day and rolling 30-day
  comparisons, best/worst posts, averages, follower growth, and heuristic
  hashtag/format performance.

Every reusable object and field is also described in `/openapi.json` under
`components.schemas`.

## Running locally

```bash
npm install
cp .env.example .env
npm run keygen          # prints an API key and the API_KEY_HASHES value to set
# edit .env: API_KEY_HASHES, CHATGPT_ACCESS_TOKEN, CREDENTIAL_ENCRYPTION_KEY,
#            X_CLIENT_ID, X_CLIENT_SECRET, X_OAUTH_REDIRECT_URI
npm run dev
```

Then:

```bash
curl http://localhost:3000/healthz
curl -H "Authorization: Bearer <the key from keygen>" http://localhost:3000/v1/accounts
```

Open <http://localhost:3000/docs> for the interactive documentation.

The service starts with zero accounts so the first account can be added through
`POST /v1/connections/x`. It refuses to start without an admin API key, the
ChatGPT URL token, or the credential encryption key.

```
Configuration error

No API keys configured, so every request would be rejected. Set API_KEY_HASHES
(preferred) or API_KEYS. See .env.example.
```

### Scripts

| Command             | Purpose                           |
| ------------------- | --------------------------------- |
| `npm run dev`       | Watch mode with reload.           |
| `npm run build`     | Compile TypeScript to `dist/`.    |
| `npm start`         | Run the compiled server.          |
| `npm test`          | Run the test suite.               |
| `npm run typecheck` | Type-check without emitting.      |
| `npm run lint`      | Check formatting.                 |
| `npm run format`    | Apply formatting.                 |
| `npm run keygen`    | Generate an API key and its hash. |

## Deploying to Render

`render.yaml` is a Render Blueprint, so the service can be created from this
repository directly.

1. In Render, choose **New → Blueprint** and point it at this repository.
2. Render reads `render.yaml` and creates a Node web service with
   `healthCheckPath: /healthz`.
3. Set the secrets it marks `sync: false` in the service's **Environment** tab:

   | Variable                    | Value                                                 |
   | --------------------------- | ----------------------------------------------------- |
   | `API_KEY_HASHES`            | Output of `npm run keygen` (comma-separate more)      |
   | `CHATGPT_ACCESS_TOKEN`      | 32+ character URL-safe random token                   |
   | `CREDENTIAL_ENCRYPTION_KEY` | `openssl rand -base64 48` output                      |
   | `X_CLIENT_ID`               | Shared X OAuth 2.0 developer app client ID            |
   | `X_CLIENT_SECRET`           | Shared client secret, if the app is confidential      |
   | `X_OAUTH_REDIRECT_URI`      | `https://project-g-wing.onrender.com/auth/x/callback` |

   Add each account using `POST /v1/oauth/x/authorize`, then open its returned
   authorization URL while logged into that X account.

4. Deploy. Render assigns an HTTPS URL and terminates TLS at its load balancer;
   `TRUST_PROXY=true` is already set so the HTTPS check reads
   `X-Forwarded-Proto` correctly.

Do not set `PORT` — Render provides it.

To deploy without the Blueprint, create a Node web service with build command
`npm ci && npm run build`, start command `npm start`, health check path
`/healthz`, and the environment variables from `.env.example`.

## Configuration reference

All configuration is environment variables; see `.env.example` for the annotated
list.

| Variable                     | Default                   | Purpose                                                     |
| ---------------------------- | ------------------------- | ----------------------------------------------------------- |
| `API_KEY_HASHES`             | —                         | SHA-256 hashes of accepted API keys. One is required.       |
| `API_KEYS`                   | —                         | Plaintext keys, for local use. Min. 24 characters.          |
| `CHATGPT_ACCESS_TOKEN`       | —                         | Required 32+ character URL token for GET-only ChatGPT API.  |
| `CHATGPT_RATE_LIMIT_MAX`     | `30`                      | ChatGPT requests per token per rate-limit window.           |
| `X_BEARER_TOKEN`             | —                         | X Bearer token shared by all account slots.                 |
| `X_ACCOUNT_<n>_USERNAME`     | —                         | Handle to expose in slot `n`.                               |
| `X_ACCOUNT_<n>_ID`           | the handle                | Id used in URLs.                                            |
| `X_ACCOUNT_<n>_LABEL`        | `@handle`                 | Display name.                                               |
| `X_ACCOUNT_<n>_BEARER_TOKEN` | `X_BEARER_TOKEN`          | Per-account token override.                                 |
| `X_USERNAME`                 | —                         | Shorthand for a single account.                             |
| `PORT`                       | `3000`                    | Listen port. Render sets this.                              |
| `HOST`                       | `0.0.0.0`                 | Listen address.                                             |
| `LOG_LEVEL`                  | `info`                    | Pino log level.                                             |
| `REQUIRE_HTTPS`              | on in production          | Reject plaintext HTTP on `/v1`.                             |
| `TRUST_PROXY`                | `true`                    | Read `X-Forwarded-*`. Required behind a TLS-terminating LB. |
| `CORS_ORIGINS`               | none                      | Browser origins allowed. Empty blocks all.                  |
| `ENABLE_DOCS`                | `true`                    | Serve `/docs`.                                              |
| `RATE_LIMIT_MAX`             | `60`                      | Requests per key per window.                                |
| `RATE_LIMIT_WINDOW_SECONDS`  | `60`                      | Window length.                                              |
| `CACHE_TTL_SECONDS`          | `300`                     | How long X data is reused.                                  |
| `ANALYTICS_TWEET_LIMIT`      | `100`                     | Posts per account in the window (5–100).                    |
| `SYNC_POST_LIMIT`            | `500`                     | Posts paginated per persistent sync (5–3200).               |
| `TOP_TWEETS_COUNT`           | `5`                       | Top posts returned per account.                             |
| `X_API_BASE_URL`             | `https://api.x.com/2`     | Upstream base URL.                                          |
| `X_TIMEOUT_MS`               | `10000`                   | Upstream request timeout.                                   |
| `CREDENTIAL_ENCRYPTION_KEY`  | —                         | Required key used to encrypt all account token sets.        |
| `X_CLIENT_ID`                | —                         | One shared X developer application client ID.               |
| `X_CLIENT_SECRET`            | —                         | Shared confidential-client secret, when applicable.         |
| `X_OAUTH_REDIRECT_URI`       | —                         | Exact X OAuth callback, ending `/auth/x/callback`.          |
| `X_OAUTH_SCOPES`             | read-only scopes          | OAuth scopes requested for every account connection.        |
| `DATA_FILE`                  | `./data/x-analytics.json` | Durable encrypted connection and analytics store.           |
| `SYNC_INTERVAL_SECONDS`      | `900`                     | Background snapshot interval.                               |

## Security notes

- **API keys are stored hashed.** `API_KEY_HASHES` holds SHA-256 digests, so the
  running process never has a usable key in memory. Comparison is constant-time
  across every configured key, with no early exit, so timing does not reveal
  which key matched or how many exist.
- **Fail closed.** With no keys configured the process refuses to boot rather
  than start up unprotected.
- **HTTPS enforced.** In production a plaintext request to `/v1` is rejected
  with 403 before the key is even examined, and HSTS is sent. `/healthz` stays
  reachable over HTTP so a platform health check inside the private network
  still works.
- **Secrets never appear in output.** X tokens and internal secret references
  are never returned. Authorization, cookie, access-token, refresh-token, and
  client-secret fields are redacted from logs. An
  upstream rejection is reported as `upstream_unauthorized` without echoing the
  credential. Tests assert both.
- **ChatGPT is read-only.** `/api/chatgpt/:token/:account` has one GET route;
  no POST, PUT, DELETE, connection health, OAuth, or secret data is reachable
  through it. Its path token is redacted from application logs and error text.
- **OAuth is account-safe.** The one-time state and PKCE verifier are stored
  encrypted, expire after ten minutes, and can be used only once. The callback
  never returns OAuth values; X `/2/users/me` determines the account.
- **No browser access by default.** `CORS_ORIGINS` is empty, so no web origin
  can call the API until you name one.
- **Rate limited per key**, keyed by a hash of the presented key rather than the
  key itself, falling back to client IP for unauthenticated requests.
- **Caching protects your X quota.** Concurrent requests for the same account
  are de-duplicated into a single upstream call, so a chatty agent cannot
  exhaust your X rate limit.
- **Read-only by construction.** The X client issues only GET requests and
  exposes no method that writes.

## Project layout

```
src/
  index.ts                  entrypoint: config, wiring, graceful shutdown
  server.ts                 Fastify app: security plugins, error envelope, routes
  auth/
    apiKey.ts               hashed key store, constant-time verification
    plugin.ts               Bearer + HTTPS guard for /v1
  config/
    env.ts                  environment schema and defaults
    accounts.ts             X_ACCOUNT_<n>_* slot parsing
  routes/
    health.ts               unauthenticated index and probe
    v1.ts                   the authenticated endpoints
    oauth.ts                public X OAuth callback only
  services/
    analyticsService.ts     caching, per-account isolation
    connectionService.ts    auto-detection, OAuth lifecycle, sync and summaries
    xOAuthService.ts        PKCE authorization start and callback completion
  security/
    credentialVault.ts      AES-256-GCM account credential encryption
  storage/
    repository.ts           atomic durable history and connection store
    types.ts                persistent record definitions
  openapi/
    schemas.ts              reusable field-level API documentation
  x/
    client.ts               X API v2 client, upstream error mapping
    analytics.ts            pure metric computation
    types.ts                X API payload types
  lib/
    cache.ts                TTL cache with in-flight de-duplication
    errors.ts               error types and the response envelope
tests/                      unit and end-to-end tests over auth, metrics, routes,
                            encrypted connections and persistent history
```

## Tests

```bash
npm test
```

The suite covers metric computation against fixture data (including empty
windows, missing metrics and partial impression coverage), account and
environment parsing, API key verification, and the HTTP surface end to end —
auth rejection, HTTPS enforcement, caching, rate limiting, per-account failure
isolation, and every upstream error path. The X API is stubbed at the `fetch`
boundary, so the real client and error mapping are exercised and no test
touches the network.
