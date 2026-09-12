import type { FastifyPluginAsync, onRequestHookHandler } from "fastify";
import type { XOAuthService } from "../services/xOAuthService.js";

interface OAuthCallbackQuery {
  code?: string;
  state?: string;
  error?: string;
}

interface OAuthSetupParams {
  setupToken: string;
}

export interface OAuthRouteOptions {
  oauthService: XOAuthService;
  httpsHook: onRequestHookHandler;
  rateLimitHook: onRequestHookHandler;
  setupAuthHook?: onRequestHookHandler;
}

const callbackQuery = {
  type: "object",
  properties: {
    code: { type: "string" },
    state: { type: "string" },
    error: { type: "string" },
    error_description: { type: "string" },
  },
} as const;

/**
 * X redirects the browser here after user approval. It is intentionally the
 * only public OAuth route: initiating an authorization is an admin operation.
 */
export const oauthRoutes: FastifyPluginAsync<OAuthRouteOptions> = async (
  app,
  { oauthService, httpsHook, rateLimitHook, setupAuthHook },
) => {
  if (setupAuthHook) {
    app.get<{ Params: OAuthSetupParams }>(
      "/auth/x/:setupToken",
      {
        onRequest: [rateLimitHook, setupAuthHook],
        schema: {
          tags: ["connections"],
          hide: true,
          summary: "Start X OAuth from a protected browser URL",
        },
      },
      async (_request, reply) => {
        const { authorization_url: authorizationUrl } = oauthService.begin();
        return reply.header("Cache-Control", "no-store").redirect(authorizationUrl);
      },
    );
  }

  app.get<{ Querystring: OAuthCallbackQuery }>(
    "/auth/x/callback",
    {
      onRequest: [rateLimitHook, httpsHook],
      schema: {
        tags: ["connections"],
        hide: true,
        querystring: callbackQuery,
        summary: "X OAuth callback",
      },
    },
    async (request, reply) => {
      const connection = await oauthService.complete(request.query);
      // Do not include OAuth code/state/token values in the browser response.
      return reply
        .type("text/html; charset=utf-8")
        .header("Cache-Control", "no-store")
        .send(
          `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>X account connected</title></head><body><h1>X account connected</h1><p>@${escapeHtml(connection.username)} is connected. You can close this tab.</p></body></html>`,
        );
    },
  );
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const replacements: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return replacements[character]!;
  });
}
