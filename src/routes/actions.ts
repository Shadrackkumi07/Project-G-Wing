import type { FastifyPluginAsync, onRequestHookHandler } from "fastify";
import type { ConnectionService } from "../services/connectionService.js";

type ActionAccount = "bloomquest" | "serionflow";

interface DaysQuery {
  days?: number;
}

const accountAliases: Record<ActionAccount, string> = {
  bloomquest: "bloomquestapp",
  serionflow: "SerionFlow",
};

const daysQuery = {
  type: "object",
  properties: {
    days: {
      type: "integer",
      minimum: 1,
      maximum: 3650,
      default: 30,
      description: "Number of calendar days of posts to analyse.",
    },
  },
} as const;

function actionOpenApi(baseUrl: string) {
  return {
    openapi: "3.1.0",
    info: {
      title: "Project G Wing X Analytics Action",
      version: "1.0.0",
      description:
        "Read-only X performance analytics for BloomQuest and SerionFlow. " +
        "Responses never include X credentials, OAuth tokens, connection health, or admin data.",
    },
    servers: [{ url: baseUrl }],
    components: {
      securitySchemes: {
        actionBearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "API key",
          description: "The dedicated Custom GPT Action key.",
        },
      },
    },
    paths: Object.fromEntries(
      (Object.keys(accountAliases) as ActionAccount[]).map((account) => [
        `/actions/x/${account}`,
        {
          get: {
            operationId: `get${account[0]!.toUpperCase()}${account.slice(1)}Analytics`,
            summary: `Get ${account === "bloomquest" ? "BloomQuest" : "SerionFlow"} X analytics`,
            description:
              "Returns sanitized account history, posts, derived rates, and 7/30-day performance summaries.",
            security: [{ actionBearerAuth: [] }],
            parameters: [
              {
                name: "days",
                in: "query",
                required: false,
                schema: { type: "integer", minimum: 1, maximum: 3650, default: 30 },
                description: "Number of calendar days of posts to return.",
              },
            ],
            responses: {
              "200": {
                description: "Sanitized account analytics.",
                content: { "application/json": { schema: { type: "object" } } },
              },
              "401": { description: "Missing or invalid Action API key." },
              "429": { description: "Rate limit exceeded." },
            },
          },
        },
      ]),
    ),
  };
}

async function analyticsResponse(
  connectionService: ConnectionService,
  account: string,
  days: number,
) {
  const accountHistory = await connectionService.accountAnalytics(account, days);
  const posts = await connectionService.posts(account, days);
  const summary7d = await connectionService.summary(account, 7);
  const summary30d = await connectionService.summary(account, 30);
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
}

export interface ActionRouteOptions {
  baseUrl: string;
  connectionService: ConnectionService;
  authHook: onRequestHookHandler;
  rateLimitHook: onRequestHookHandler;
}

/**
 * A deliberately small Custom GPT Action surface. The two fixed account names
 * prevent the Action key from discovering connection IDs or admin routes.
 */
export const actionRoutes: FastifyPluginAsync<ActionRouteOptions> = async (
  app,
  { baseUrl, connectionService, authHook, rateLimitHook },
) => {
  app.get(
    "/openapi.json",
    {
      schema: {
        hide: true,
        summary: "Custom GPT Action OpenAPI specification",
      },
    },
    async (_request, reply) =>
      reply.header("Cache-Control", "no-store").send(actionOpenApi(baseUrl)),
  );

  app.register(
    async (secured) => {
      secured.addHook("onRequest", rateLimitHook);
      secured.addHook("onRequest", authHook);

      secured.get<{ Params: { account: ActionAccount }; Querystring: DaysQuery }>(
        "/x/:account",
        {
          schema: {
            tags: ["custom-gpt-action"],
            summary: "Sanitized read-only X analytics for a Custom GPT Action",
            description:
              "Returns only account analytics, posts, and summaries. It never returns X credentials, " +
              "OAuth tokens, connection health, internal secret references, or admin routes.",
            params: {
              type: "object",
              required: ["account"],
              properties: { account: { enum: ["bloomquest", "serionflow"] } },
            },
            querystring: daysQuery,
            security: [{ actionBearerAuth: [] }],
          },
        },
        async (request, reply) => {
          const days = request.query.days ?? 30;
          return reply
            .header("Cache-Control", "no-store")
            .send(
              await analyticsResponse(
                connectionService,
                accountAliases[request.params.account],
                days,
              ),
            );
        },
      );
    },
    { prefix: "/" },
  );
};
