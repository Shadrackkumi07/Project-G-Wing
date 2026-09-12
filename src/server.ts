import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";

import type { Env } from "./config/env.js";
import type { ApiKeyStore } from "./auth/apiKey.js";
import { extractBearerToken } from "./auth/apiKey.js";
import { createAuthHook } from "./auth/plugin.js";
import { ApiError } from "./lib/errors.js";
import { healthRoutes } from "./routes/health.js";
import { v1Routes } from "./routes/v1.js";
import type { AnalyticsService } from "./services/analyticsService.js";

export interface BuildServerOptions {
  env: Env;
  apiKeyStore: ApiKeyStore;
  service: AnalyticsService;
}

function rateLimitKey(store: ApiKeyStore, authorization: string | undefined, ip: string): string {
  const presented = extractBearerToken(authorization);
  if (!presented) return `ip:${ip}`;

  // Only a recognised key earns its own bucket — and `keyId` is a digest
  // prefix, so the key itself never enters the limiter's store. An unknown
  // token falls back to the caller's IP: bucketing by the presented value
  // would let a client rotate random tokens to mint a fresh allowance per
  // request and brute-force keys unchecked.
  const keyId = store.verify(presented);
  return keyId ? `key:${keyId}` : `ip:${ip}`;
}

export async function buildServer({
  env,
  apiKeyStore,
  service,
}: BuildServerOptions): Promise<FastifyInstance> {
  const app = Fastify({
    trustProxy: env.TRUST_PROXY,
    bodyLimit: 64 * 1024,
    logger: {
      level: env.NODE_ENV === "test" ? "silent" : env.LOG_LEVEL,
      redact: {
        paths: ["req.headers.authorization", "req.headers.cookie"],
        censor: "[redacted]",
      },
    },
  });

  await app.register(helmet, {
    // The docs page is the only HTML this service serves; Swagger UI needs
    // inline script and style to boot.
    contentSecurityPolicy: env.ENABLE_DOCS
      ? {
          directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: ["'self'", "data:"],
            workerSrc: ["'self'", "blob:"],
          },
        }
      : { directives: { defaultSrc: ["'self'"] } },
    hsts: env.REQUIRE_HTTPS ? { maxAge: 15_552_000, includeSubDomains: true } : false,
  });

  const corsOrigins = (env.CORS_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin !== "");

  await app.register(cors, {
    // Default: no browser origin is allowed. This is a server-to-server API.
    origin: corsOrigins.length > 0 ? corsOrigins : false,
    methods: ["GET", "OPTIONS"],
    allowedHeaders: ["authorization", "content-type"],
    maxAge: 600,
  });

  // global:false so the limiter is not attached per route, where it would run
  // *after* the /v1 scope's authentication hook and therefore never see a
  // rejected request. The hook is placed explicitly ahead of auth instead.
  await app.register(rateLimit, { global: false });

  const rateLimitHook = app.rateLimit({
    max: env.RATE_LIMIT_MAX,
    timeWindow: env.RATE_LIMIT_WINDOW_SECONDS * 1000,
    keyGenerator: (request) => rateLimitKey(apiKeyStore, request.headers.authorization, request.ip),
    // The plugin throws this value verbatim, so it must be a real ApiError for
    // the error handler below to recognise it and keep the response envelope
    // consistent with every other error.
    errorResponseBuilder: (_request, context) =>
      new ApiError(
        429,
        "rate_limited",
        `Rate limit exceeded: at most ${context.max} requests per ${env.RATE_LIMIT_WINDOW_SECONDS}s.`,
        { retry_after_seconds: Math.ceil(context.ttl / 1000) },
      ),
  });

  await app.register(swagger, {
    openapi: {
      openapi: "3.1.0",
      info: {
        title: "X Analytics API",
        version: "1.0.0",
        description:
          "Read-only analytics for a fixed set of X (Twitter) accounts, intended for AI agents " +
          "and humans. X API credentials live only in this service's environment and are never " +
          "accepted from, or returned to, callers.",
      },
      components: {
        securitySchemes: {
          bearerAuth: {
            type: "http",
            scheme: "bearer",
            description: "An API key issued for this service. Send over HTTPS only.",
          },
        },
      },
      tags: [
        { name: "meta", description: "Service metadata and health." },
        { name: "accounts", description: "Which X accounts are exposed." },
        { name: "analytics", description: "Per-account analytics." },
      ],
    },
  });

  if (env.ENABLE_DOCS) {
    await app.register(swaggerUi, {
      routePrefix: "/docs",
      uiConfig: { docExpansion: "list", deepLinking: true },
    });
  }

  app.get("/openapi.json", { schema: { hide: true } }, async () => app.swagger());

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof ApiError) {
      reply.status(error.statusCode).send(error.toJSON());
      return;
    }

    if (error.validation) {
      reply.status(400).send({
        error: { code: "bad_request", message: error.message },
      });
      return;
    }

    // The rate limiter and other plugins set statusCode with a safe message.
    if (typeof error.statusCode === "number" && error.statusCode < 500) {
      reply.status(error.statusCode).send({
        error: { code: "bad_request", message: error.message },
      });
      return;
    }

    request.log.error({ err: error }, "Unhandled error while serving request");
    reply.status(500).send({
      error: { code: "internal_error", message: "An unexpected error occurred." },
    });
  });

  app.setNotFoundHandler((request, reply) => {
    reply.status(404).send({
      error: {
        code: "not_found",
        message: `No route for ${request.method} ${request.url}. See GET / for the endpoint list.`,
      },
    });
  });

  const authHook = createAuthHook({
    store: apiKeyStore,
    requireHttps: env.REQUIRE_HTTPS,
  });

  await app.register(healthRoutes, { service });
  await app.register(v1Routes, { service, authHook, rateLimitHook, prefix: "/v1" });

  return app;
}
