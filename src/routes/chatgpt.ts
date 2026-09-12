import type { FastifyPluginAsync, onRequestHookHandler } from "fastify";
import type { ConnectionService } from "../services/connectionService.js";

interface ChatGptParams {
  accessToken: string;
  account: string;
}

interface DaysQuery {
  days?: number;
}

export interface ChatGptRouteOptions {
  connectionService: ConnectionService;
  authHook: onRequestHookHandler;
  rateLimitHook: onRequestHookHandler;
}

const params = {
  type: "object",
  required: ["accessToken", "account"],
  properties: {
    accessToken: {
      type: "string",
      description: "Long secret URL token. It is never returned or logged.",
    },
    account: { type: "string", description: "X account ID, handle, or connection ID." },
  },
} as const;

const daysQuery = {
  type: "object",
  properties: {
    days: { type: "integer", minimum: 1, maximum: 3650, default: 30 },
  },
} as const;

/**
 * This is intentionally a GET-only, sanitized surface for ChatGPT. Admin
 * connection endpoints remain exclusively under authenticated /v1 routes.
 */
export const chatGptRoutes: FastifyPluginAsync<ChatGptRouteOptions> = async (
  app,
  { connectionService, authHook, rateLimitHook },
) => {
  app.addHook("onRequest", rateLimitHook);
  app.addHook("onRequest", authHook);

  app.get<{ Params: ChatGptParams; Querystring: DaysQuery }>(
    "/:accessToken/:account",
    {
      schema: {
        tags: ["chatgpt"],
        summary: "Sanitized read-only X analytics for ChatGPT",
        description:
          "Returns only account analytics, posts, and 7/30-day summaries. It never returns " +
          "X credentials, connection health, refresh data, internal secret references, or admin routes.",
        params,
        querystring: daysQuery,
      },
    },
    async (request) => {
      const days = request.query.days ?? 30;
      const accountHistory = await connectionService.accountAnalytics(request.params.account, days);
      const posts = await connectionService.posts(request.params.account, days);
      const summary7d = await connectionService.summary(request.params.account, 7);
      const summary30d = await connectionService.summary(request.params.account, 30);
      const current = accountHistory.current;
      const { account: _summary7dAccount, ...safeSummary7d } = summary7d;
      const { account: _summary30dAccount, ...safeSummary30d } = summary30d;

      return {
        account: {
          id: accountHistory.account.x_account_id,
          handle: accountHistory.account.username,
          display_name: accountHistory.account.display_name,
          followers: current?.followers ?? null,
          following: current?.following ?? null,
          total_posts: current?.total_posts ?? null,
          current_timestamp: current?.captured_at ?? null,
        },
        analytics_history: accountHistory.history,
        posts: posts.posts,
        summary_7d: safeSummary7d,
        summary_30d: safeSummary30d,
        generated_at: new Date().toISOString(),
      };
    },
  );
};
