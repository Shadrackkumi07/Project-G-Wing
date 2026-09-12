import type { FastifyPluginAsync, onRequestHookHandler } from "fastify";
import type { AnalyticsService } from "../services/analyticsService.js";
import type { ConnectionService, NewConnectionInput } from "../services/connectionService.js";
import type { XOAuthService } from "../services/xOAuthService.js";

export interface V1RouteOptions {
  service: AnalyticsService;
  authHook: onRequestHookHandler;
  rateLimitHook: onRequestHookHandler;
  connectionService?: ConnectionService;
  oauthService?: XOAuthService;
}

const accountParams = {
  type: "object",
  required: ["accountId"],
  properties: {
    accountId: {
      type: "string",
      pattern: "^[a-zA-Z0-9][a-zA-Z0-9-]{0,62}$",
      description: "Account id from GET /v1/accounts.",
    },
  },
} as const;

interface AccountParams {
  accountId: string;
}

interface DaysQuery {
  days?: number;
}
interface PostParams extends AccountParams {
  postId: string;
}
interface ConnectionParams {
  id: string;
}

const daysQuery = {
  type: "object",
  properties: {
    days: {
      type: "integer",
      minimum: 1,
      maximum: 3650,
      default: 30,
      description: "Number of calendar days to include.",
    },
  },
} as const;

const connectionBody = {
  type: "object",
  additionalProperties: false,
  required: ["access_token"],
  properties: {
    access_token: {
      type: "string",
      minLength: 1,
      description: "X user-context access token; accepted only in this request and never returned.",
    },
    refresh_token: {
      type: "string",
      minLength: 1,
      description: "Optional OAuth refresh token; encrypted before persistence and never returned.",
    },
    token_expires_at: {
      type: "string",
      format: "date-time",
      description: "Optional access-token expiration timestamp.",
    },
    token_type: { type: "string", description: "OAuth token type, normally bearer." },
    scope: {
      type: "string",
      description: "Granted OAuth scopes; use read-only tweet.read users.read offline.access.",
    },
  },
} as const;

const safeConnectionResponse = {
  200: { $ref: "SafeConnection#" },
} as const;

const historyResponse = {
  200: {
    type: "object",
    additionalProperties: true,
    properties: {
      account: { $ref: "SafeConnection#" },
      current: { anyOf: [{ $ref: "AccountSnapshot#" }, { type: "null" }] },
      history: { type: "array", items: { $ref: "AccountSnapshot#" } },
    },
  },
} as const;

const postsResponse = {
  200: {
    type: "object",
    additionalProperties: true,
    properties: {
      account: { $ref: "SafeConnection#" },
      posts: {
        type: "array",
        items: { $ref: "PostAnalytics#" },
      },
    },
  },
} as const;

/**
 * Legacy responses remain deliberately unschematised for backward
 * compatibility. Persistent connection/history responses use shared OpenAPI
 * schemas with additionalProperties where future X metrics may appear.
 */
export const v1Routes: FastifyPluginAsync<V1RouteOptions> = async (
  app,
  { service, authHook, rateLimitHook, connectionService, oauthService },
) => {
  // Order matters: rate limiting must precede authentication, or an
  // unauthenticated caller could retry keys without ever being throttled.
  app.addHook("onRequest", rateLimitHook);
  app.addHook("onRequest", authHook);

  app.get(
    "/accounts",
    {
      schema: {
        tags: ["accounts"],
        summary: "List configured X accounts",
        description:
          "Returns the id, label and handle of every account this service is configured to " +
          "report on. Credentials are never included.",
        security: [{ bearerAuth: [] }],
      },
    },
    async () => ({
      accounts: connectionService
        ? [
            ...service.listAccounts(),
            ...connectionService.list().map((item) => ({
              id: item.id,
              label: item.display_name,
              username: item.username,
              x_account_id: item.x_account_id,
              status: item.connection_status,
              last_synced_at: item.last_synced_at,
            })),
          ]
        : service.listAccounts(),
    }),
  );

  app.get<{ Params: AccountParams }>(
    "/accounts/:accountId",
    {
      schema: {
        tags: ["accounts"],
        summary: "Profile and audience snapshot for one account",
        description:
          "Profile fields, follower/following counts and lifetime totals for a single account.",
        params: accountParams,
        security: [{ bearerAuth: [] }],
      },
    },
    async (request) => service.getProfile(request.params.accountId),
  );

  app.get<{ Params: AccountParams }>(
    "/accounts/:accountId/analytics",
    {
      schema: {
        tags: ["analytics"],
        summary: "Full analytics for one account",
        description:
          "Audience, engagement totals and per-post averages, content composition " +
          "(original/reply/retweet/quote), posting cadence by UTC hour and weekday, and the " +
          "top posts by engagement over the analysed window. The 'notes' array explains any " +
          "metric that could not be calculated.",
        params: accountParams,
        security: [{ bearerAuth: [] }],
      },
    },
    async (request) => service.getAnalytics(request.params.accountId),
  );

  app.get<{ Params: AccountParams }>(
    "/accounts/:accountId/tweets",
    {
      schema: {
        tags: ["analytics"],
        summary: "Recent posts with per-post metrics",
        description:
          "The posts backing the analytics window, each with its own like, retweet, reply, " +
          "quote, bookmark and impression counts.",
        params: accountParams,
        security: [{ bearerAuth: [] }],
      },
    },
    async (request) => service.getTweets(request.params.accountId),
  );

  app.get(
    "/analytics",
    {
      schema: {
        tags: ["analytics"],
        summary: "Full analytics for every configured account",
        description:
          "One entry per configured account, each with its own status. An account that fails " +
          "(revoked token, rate limit, suspended handle) is reported as status 'error' without " +
          "affecting the accounts that succeeded, so this endpoint returns 200 as long as the " +
          "service itself is healthy.",
        security: [{ bearerAuth: [] }],
      },
    },
    async () => service.getAllAnalytics(),
  );

  if (connectionService) {
    if (oauthService) {
      app.post(
        "/oauth/x/authorize",
        {
          schema: {
            tags: ["connections"],
            summary: "Start X OAuth connection for the X account currently signed in",
            description:
              "Returns a one-time X authorization URL. Open it in a browser while signed into " +
              "the X account to connect. The callback identifies the account automatically.",
            response: {
              200: {
                type: "object",
                required: ["authorization_url", "expires_at"],
                properties: {
                  authorization_url: { type: "string", format: "uri" },
                  expires_at: { type: "string", format: "date-time" },
                },
              },
            },
            security: [{ bearerAuth: [] }],
          },
        },
        async () => oauthService.begin(),
      );
    }

    app.post<{ Body: NewConnectionInput }>(
      "/connections/x",
      {
        schema: {
          tags: ["connections"],
          summary: "Validate and add an X account connection",
          body: connectionBody,
          response: { 201: { $ref: "SafeConnection#" } },
          security: [{ bearerAuth: [] }],
        },
      },
      async (request, reply) =>
        reply.status(201).send(await connectionService.create(request.body)),
    );

    app.get(
      "/connections",
      {
        schema: {
          tags: ["connections"],
          summary: "List connection identities and health; credentials are never returned",
          response: {
            200: {
              type: "object",
              properties: { connections: { type: "array", items: { $ref: "SafeConnection#" } } },
            },
          },
          security: [{ bearerAuth: [] }],
        },
      },
      async () => ({ connections: connectionService.list() }),
    );

    app.get<{ Params: ConnectionParams }>(
      "/connections/:id",
      {
        schema: {
          tags: ["connections"],
          summary: "Get connection identity and health",
          response: safeConnectionResponse,
          security: [{ bearerAuth: [] }],
        },
      },
      async (request) => connectionService.get(request.params.id),
    );

    app.put<{ Params: ConnectionParams; Body: NewConnectionInput }>(
      "/connections/:id",
      {
        schema: {
          tags: ["connections"],
          summary: "Validate and replace credentials for the same detected X account",
          body: connectionBody,
          response: safeConnectionResponse,
          security: [{ bearerAuth: [] }],
        },
      },
      async (request) => connectionService.replaceCredentials(request.params.id, request.body),
    );

    app.post<{ Params: ConnectionParams }>(
      "/connections/:id/test",
      {
        schema: {
          tags: ["connections"],
          summary: "Verify credentials still identify the same X account",
          response: safeConnectionResponse,
          security: [{ bearerAuth: [] }],
        },
      },
      async (request) => connectionService.test(request.params.id),
    );

    app.post<{ Params: ConnectionParams }>(
      "/connections/:id/refresh",
      {
        schema: {
          tags: ["connections"],
          summary: "Refresh an OAuth access token",
          response: safeConnectionResponse,
          security: [{ bearerAuth: [] }],
        },
      },
      async (request) => connectionService.refresh(request.params.id),
    );

    app.post<{ Params: ConnectionParams }>(
      "/connections/:id/sync",
      {
        schema: {
          tags: ["connections"],
          summary: "Pull and persist a new account/post metric snapshot",
          response: safeConnectionResponse,
          security: [{ bearerAuth: [] }],
        },
      },
      async (request) => connectionService.sync(request.params.id),
    );

    app.delete<{ Params: ConnectionParams }>(
      "/connections/:id",
      {
        schema: {
          tags: ["connections"],
          summary: "Delete a connection and its encrypted credential",
          security: [{ bearerAuth: [] }],
        },
      },
      async (request, reply) => {
        connectionService.delete(request.params.id);
        return reply.status(204).send();
      },
    );

    app.get<{ Params: AccountParams; Querystring: DaysQuery }>(
      "/analytics/:accountId",
      {
        schema: {
          tags: ["history"],
          summary: "Account analytics and follower history",
          params: accountParams,
          querystring: daysQuery,
          response: historyResponse,
          security: [{ bearerAuth: [] }],
        },
      },
      async (request) =>
        connectionService.accountAnalytics(request.params.accountId, request.query.days ?? 30),
    );

    app.get<{ Params: AccountParams; Querystring: DaysQuery }>(
      "/posts/:accountId",
      {
        schema: {
          tags: ["history"],
          summary: "Stored posts, latest metrics, rates, and relative performance",
          params: accountParams,
          querystring: daysQuery,
          response: postsResponse,
          security: [{ bearerAuth: [] }],
        },
      },
      async (request) =>
        connectionService.posts(request.params.accountId, request.query.days ?? 30),
    );

    app.get<{ Params: PostParams }>(
      "/posts/:accountId/:postId",
      {
        schema: {
          tags: ["history"],
          summary: "One post with complete metric history and age milestones",
          response: {
            200: {
              type: "object",
              additionalProperties: true,
              properties: {
                account: { $ref: "SafeConnection#" },
                post: { $ref: "StoredPost#" },
                metrics: { anyOf: [{ $ref: "CurrentPostMetric#" }, { type: "null" }] },
                metric_history: { type: "array", items: { $ref: "PostMetric#" } },
              },
            },
          },
          security: [{ bearerAuth: [] }],
        },
      },
      async (request) => connectionService.post(request.params.accountId, request.params.postId),
    );

    app.get<{ Params: AccountParams; Querystring: DaysQuery }>(
      "/summary/:accountId",
      {
        schema: {
          tags: ["history"],
          summary: "Period comparisons, best/worst posts, growth, topic and format performance",
          params: accountParams,
          querystring: daysQuery,
          response: postsResponse,
          security: [{ bearerAuth: [] }],
        },
      },
      async (request) =>
        connectionService.summary(request.params.accountId, request.query.days ?? 7),
    );
  }
};
