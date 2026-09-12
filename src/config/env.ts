import { z } from "zod";
import { ConfigError } from "../lib/errors.js";

const booleanish = z.union([z.boolean(), z.string()]).transform((value, ctx) => {
  if (typeof value === "boolean") return value;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off", ""].includes(normalized)) return false;
  ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Expected a boolean, got "${value}"` });
  return z.NEVER;
});

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().min(1).default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),

  API_KEYS: z.string().optional(),
  API_KEY_HASHES: z.string().optional(),
  CHATGPT_ACCESS_TOKEN: z.string().min(32).optional(),
  CHATGPT_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(30),

  REQUIRE_HTTPS: booleanish.optional(),
  TRUST_PROXY: booleanish.default(true),
  CORS_ORIGINS: z.string().optional(),
  ENABLE_DOCS: booleanish.default(true),

  RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(60),
  RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().min(1).default(60),

  X_API_BASE_URL: z.string().url().default("https://api.x.com/2"),
  X_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60_000).default(10_000),
  CACHE_TTL_SECONDS: z.coerce.number().int().min(0).max(86_400).default(300),
  ANALYTICS_TWEET_LIMIT: z.coerce.number().int().min(5).max(100).default(100),
  SYNC_POST_LIMIT: z.coerce.number().int().min(5).max(3200).default(500),
  TOP_TWEETS_COUNT: z.coerce.number().int().min(1).max(50).default(5),
  DATA_FILE: z.string().min(1).default("./data/x-analytics.json"),
  CREDENTIAL_ENCRYPTION_KEY: z.string().min(32).optional(),
  X_CLIENT_ID: z.string().optional(),
  X_CLIENT_SECRET: z.string().optional(),
  SYNC_INTERVAL_SECONDS: z.coerce.number().int().min(60).max(86_400).default(900),
});

export type Env = z.infer<typeof envSchema> & { REQUIRE_HTTPS: boolean };

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`);
    throw new ConfigError(`Invalid environment configuration:\n${lines.join("\n")}`);
  }

  const env = parsed.data;
  return {
    ...env,
    // HTTPS is mandatory in production but would block local http:// development.
    REQUIRE_HTTPS: env.REQUIRE_HTTPS ?? env.NODE_ENV === "production",
  };
}
