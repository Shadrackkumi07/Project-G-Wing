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
      ],
    }),
  );
};
