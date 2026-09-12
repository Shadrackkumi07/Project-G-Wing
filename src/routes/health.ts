import type { FastifyPluginAsync } from "fastify";
import type { AnalyticsService } from "../services/analyticsService.js";

export interface HealthRouteOptions {
  service: AnalyticsService;
}

/**
 * Unauthenticated liveness probe. Render (and any other platform health check)
 * calls this over plain HTTP inside the private network, so it is intentionally
 * exempt from both the API key and the HTTPS requirement, and exposes nothing
 * beyond process liveness.
 */
export const healthRoutes: FastifyPluginAsync<HealthRouteOptions> = async (app, { service }) => {
  app.get(
    "/healthz",
    {
      schema: {
        tags: ["meta"],
        summary: "Liveness probe",
        description: "Returns 200 while the process is able to serve traffic. No auth required.",
      },
    },
    async () => ({
      status: "ok",
      uptime_seconds: Math.floor(process.uptime()),
      accounts_configured: service.listAccounts().length,
    }),
  );

  app.get(
    "/",
    {
      schema: {
        tags: ["meta"],
        summary: "Service index",
        description: "Lists the available endpoints. No auth required.",
      },
    },
    async () => ({
      service: "x-analytics-api",
      description:
        "Read-only analytics for the configured X (Twitter) accounts. All /v1 endpoints " +
        "require an 'Authorization: Bearer <api-key>' header over HTTPS.",
      endpoints: [
        { method: "GET", path: "/healthz", description: "Liveness probe." },
        { method: "GET", path: "/docs", description: "Interactive OpenAPI documentation." },
        { method: "GET", path: "/openapi.json", description: "OpenAPI 3 specification." },
        {
          method: "GET",
          path: "/api/chatgpt/{token}/{account}?days=30",
          description: "Sanitized, rate-limited read-only analytics for ChatGPT.",
        },
        { method: "GET", path: "/v1/accounts", description: "List configured accounts." },
        {
          method: "GET",
          path: "/v1/accounts/{accountId}",
          description: "Profile and audience snapshot for one account.",
        },
        {
          method: "GET",
          path: "/v1/accounts/{accountId}/analytics",
          description: "Full analytics for one account.",
        },
        {
          method: "GET",
          path: "/v1/accounts/{accountId}/tweets",
          description: "Recent posts with per-post metrics for one account.",
        },
        {
          method: "GET",
          path: "/v1/analytics",
          description: "Full analytics for every configured account, reported separately.",
        },
        {
          method: "POST",
          path: "/v1/oauth/x/authorize",
          description: "Create a one-time X OAuth URL for a new account connection.",
        },
        {
          method: "GET",
          path: "/auth/x/{setup-token}",
          description: "Protected browser link that starts X OAuth for a new account.",
        },
        {
          method: "GET",
          path: "/auth/x/callback",
          description: "X OAuth redirect target; used only by X after approval.",
        },
        {
          method: "POST",
          path: "/v1/connections/x",
          description: "Validate and add an X user connection.",
        },
        {
          method: "GET",
          path: "/v1/connections",
          description: "List connection identity and health without credentials.",
        },
        {
          method: "GET",
          path: "/v1/analytics/{account}?days=30",
          description: "Persistent account snapshot history.",
        },
        {
          method: "GET",
          path: "/v1/posts/{account}?days=30",
          description: "Persistent post analytics.",
        },
        {
          method: "GET",
          path: "/v1/posts/{account}/{post_id}",
          description: "One post and all metric-age snapshots.",
        },
        {
          method: "GET",
          path: "/v1/summary/{account}?days=7",
          description: "Period comparisons and content performance.",
        },
      ],
    }),
  );
};
