import type { FastifyPluginAsync, onRequestHookHandler } from "fastify";
import type { AnalyticsService } from "../services/analyticsService.js";

export interface V1RouteOptions {
  service: AnalyticsService;
  authHook: onRequestHookHandler;
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

/**
 * Response bodies are deliberately left unschematised: Fastify strips
 * properties absent from a response schema, which would silently drop metrics
 * whenever the analytics shape grows. The OpenAPI document describes them in
 * prose instead.
 */
export const v1Routes: FastifyPluginAsync<V1RouteOptions> = async (app, { service, authHook }) => {
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
    async () => ({ accounts: service.listAccounts() }),
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
};
