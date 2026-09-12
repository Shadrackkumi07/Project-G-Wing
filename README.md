# Project G Wing

A small, read-only HTTP API that exposes analytics for a fixed set of X (Twitter)
accounts, designed to be called by an AI agent or a human.

- **Read-only.** Nothing in this service can post, delete, follow, or change
  anything on X. It only reads.
- **Credentials stay server-side.** Your X API Bearer token lives in this
  service's environment. Callers never send it and never receive it.
- **Each account reported separately.** Every configured handle gets its own
  entry with its own numbers and its own status.
- **One key to call it.** Callers authenticate with
  `Authorization: Bearer <api-key>` over HTTPS.

## How the two credentials relate

There are two different secrets, and they never mix:

```
                   Authorization: Bearer <API key>          X_BEARER_TOKEN
                   (issued by you, to callers)              (issued by X, to you)
                              │                                    │
   ┌──────────────┐           ▼           ┌──────────────┐         ▼      ┌─────────┐
   │  AI agent /  │ ────── HTTPS ───────► │  This API    │ ─── HTTPS ───► │  X API  │
   │    human     │ ◄──── analytics ───── │              │ ◄── raw data ─ │   v2    │
   └──────────────┘                       └──────────────┘                └─────────┘
```

A caller proves who it is with an **API key you issue**. This service then talks
to X with **your X credentials**, which the caller never sees. Both hops are
HTTPS, and on the `/v1` endpoints a plaintext HTTP request is rejected outright
in production, so an API key cannot be sent in the clear.

## Endpoints

| Method | Path                                 | Auth | Description                                                |
| ------ | ------------------------------------ | ---- | ---------------------------------------------------------- |
| `GET`  | `/`                                  | No   | Index of available endpoints.                              |
| `GET`  | `/healthz`                           | No   | Liveness probe.                                            |
| `GET`  | `/openapi.json`                      | No   | OpenAPI 3.1 specification.                                 |
| `GET`  | `/docs`                              | No   | Interactive documentation.                                 |
| `GET`  | `/v1/accounts`                       | Yes  | Configured accounts: id, label, handle.                    |
| `GET`  | `/v1/accounts/{accountId}`           | Yes  | Profile and audience snapshot for one account.             |
| `GET`  | `/v1/accounts/{accountId}/analytics` | Yes  | Full analytics for one account.                            |
| `GET`  | `/v1/accounts/{accountId}/tweets`    | Yes  | The posts behind the window, with per-post metrics.        |
| `GET`  | `/v1/analytics`                      | Yes  | Full analytics for **every** account, reported separately. |

The `{accountId}` is the id you assign to a handle (`X_ACCOUNT_1_ID`), not the
handle itself — so a rename on X does not change your URLs.

An agent can discover everything from `GET /` and `GET /openapi.json` without
being told the shape in advance.

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

## Getting your X credentials

1. Go to <https://developer.x.com> and create a project and an app.
2. In the app's **Keys and tokens**, generate the **Bearer Token** (OAuth 2.0
   App-Only). Read-only access is enough — this service never writes.
3. Set it as `X_BEARER_TOKEN`.

An app-only Bearer token can read any public account, so one token covers all
your handles. If a handle belongs to a different X app, give that slot its own
`X_ACCOUNT_<n>_BEARER_TOKEN`.

To get impression counts, that slot's token must be a **user-context** OAuth 2.0
access token for that specific account, with the `tweet.read` and `users.read`
scopes.

## Running locally

```bash
npm install
cp .env.example .env
npm run keygen          # prints an API key and the API_KEY_HASHES value to set
# edit .env: API_KEY_HASHES, X_BEARER_TOKEN, X_ACCOUNT_1_USERNAME
npm run dev
```

Then:

```bash
curl http://localhost:3000/healthz
curl -H "Authorization: Bearer <the key from keygen>" http://localhost:3000/v1/accounts
```

Open <http://localhost:3000/docs> for the interactive documentation.

The service refuses to start if no API keys or no X accounts are configured,
rather than starting up and rejecting every request:

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

   | Variable               | Value                                            |
   | ---------------------- | ------------------------------------------------ |
   | `API_KEY_HASHES`       | Output of `npm run keygen` (comma-separate more) |
   | `X_BEARER_TOKEN`       | Your X app's Bearer token                        |
   | `X_ACCOUNT_1_USERNAME` | The handle to expose                             |
   | `X_ACCOUNT_1_ID`       | e.g. `main`                                      |
   | `X_ACCOUNT_1_LABEL`    | e.g. `Personal`                                  |

   Add `X_ACCOUNT_2_USERNAME`, `X_ACCOUNT_2_ID`, … for further handles.

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

| Variable                     | Default               | Purpose                                                     |
| ---------------------------- | --------------------- | ----------------------------------------------------------- |
| `API_KEY_HASHES`             | —                     | SHA-256 hashes of accepted API keys. One is required.       |
| `API_KEYS`                   | —                     | Plaintext keys, for local use. Min. 24 characters.          |
| `X_BEARER_TOKEN`             | —                     | X Bearer token shared by all account slots.                 |
| `X_ACCOUNT_<n>_USERNAME`     | —                     | Handle to expose in slot `n`.                               |
| `X_ACCOUNT_<n>_ID`           | the handle            | Id used in URLs.                                            |
| `X_ACCOUNT_<n>_LABEL`        | `@handle`             | Display name.                                               |
| `X_ACCOUNT_<n>_BEARER_TOKEN` | `X_BEARER_TOKEN`      | Per-account token override.                                 |
| `X_USERNAME`                 | —                     | Shorthand for a single account.                             |
| `PORT`                       | `3000`                | Listen port. Render sets this.                              |
| `HOST`                       | `0.0.0.0`             | Listen address.                                             |
| `LOG_LEVEL`                  | `info`                | Pino log level.                                             |
| `REQUIRE_HTTPS`              | on in production      | Reject plaintext HTTP on `/v1`.                             |
| `TRUST_PROXY`                | `true`                | Read `X-Forwarded-*`. Required behind a TLS-terminating LB. |
| `CORS_ORIGINS`               | none                  | Browser origins allowed. Empty blocks all.                  |
| `ENABLE_DOCS`                | `true`                | Serve `/docs`.                                              |
| `RATE_LIMIT_MAX`             | `60`                  | Requests per key per window.                                |
| `RATE_LIMIT_WINDOW_SECONDS`  | `60`                  | Window length.                                              |
| `CACHE_TTL_SECONDS`          | `300`                 | How long X data is reused.                                  |
| `ANALYTICS_TWEET_LIMIT`      | `100`                 | Posts per account in the window (5–100).                    |
| `TOP_TWEETS_COUNT`           | `5`                   | Top posts returned per account.                             |
| `X_API_BASE_URL`             | `https://api.x.com/2` | Upstream base URL.                                          |
| `X_TIMEOUT_MS`               | `10000`               | Upstream request timeout.                                   |

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
- **Secrets never appear in output.** X tokens are never returned in any
  response, and `Authorization` and `Cookie` headers are redacted from logs. An
  upstream rejection is reported as `upstream_unauthorized` without echoing the
  credential. Tests assert both.
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
  services/
    analyticsService.ts     caching, per-account isolation
  x/
    client.ts               X API v2 client, upstream error mapping
    analytics.ts            pure metric computation
    types.ts                X API payload types
  lib/
    cache.ts                TTL cache with in-flight de-duplication
    errors.ts               error types and the response envelope
tests/                      64 tests over config, auth, metrics and routes
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
