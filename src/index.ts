import { existsSync } from "node:fs";
import { ApiKeyStore } from "./auth/apiKey.js";
import { loadAccounts } from "./config/accounts.js";
import { loadEnv } from "./config/env.js";
import { ConfigError } from "./lib/errors.js";
import { AnalyticsService } from "./services/analyticsService.js";
import { buildServer } from "./server.js";
import { XClient } from "./x/client.js";
import { Repository } from "./storage/repository.js";
import { CredentialVault } from "./security/credentialVault.js";
import { ConnectionService } from "./services/connectionService.js";
import { XOAuthService } from "./services/xOAuthService.js";

function loadDotEnvForLocalDevelopment(): void {
  // Hosting platforms inject real environment variables; a .env file is only a
  // local-development convenience.
  if (process.env.NODE_ENV === "production") return;
  if (!existsSync(".env")) return;
  process.loadEnvFile(".env");
}

async function main(): Promise<void> {
  loadDotEnvForLocalDevelopment();

  const env = loadEnv();
  const accounts = loadAccounts(process.env, { allowEmpty: true });
  const apiKeyStore = ApiKeyStore.fromEnv({
    hashes: process.env.API_KEY_HASHES,
    plaintextKeys: process.env.API_KEYS,
  });
  const chatGptTokenStore = ApiKeyStore.fromSingleSecret(
    env.CHATGPT_ACCESS_TOKEN,
    "CHATGPT_ACCESS_TOKEN",
  );
  const oauthSetupTokenStore = ApiKeyStore.fromSingleSecret(
    env.OAUTH_SETUP_TOKEN,
    "OAUTH_SETUP_TOKEN",
  );

  const client = new XClient({ baseUrl: env.X_API_BASE_URL, timeoutMs: env.X_TIMEOUT_MS });
  const service = new AnalyticsService({
    accounts,
    client,
    env,
  });

  const repository = new Repository({ dataFile: env.DATA_FILE, databaseUrl: env.DATABASE_URL });
  await repository.initialize();
  const vault = new CredentialVault(repository, env.CREDENTIAL_ENCRYPTION_KEY);
  const connectionService = new ConnectionService(repository, vault, client, env);
  const oauthService = new XOAuthService(repository, vault, client, connectionService, env);

  const app = await buildServer({
    env,
    apiKeyStore,
    service,
    connectionService,
    oauthService,
    oauthSetupTokenStore,
    chatGptTokenStore,
  });

  // Periodic snapshots make age-based comparisons possible without requiring a caller.
  const syncTimer = setInterval(() => {
    void connectionService
      .list()
      .then((connections) => {
        for (const connection of connections) {
          void connectionService.sync(connection.id).catch((error: unknown) => {
            app.log.warn({ connection_id: connection.id, err: error }, "Scheduled X sync failed");
          });
        }
      })
      .catch((error: unknown) => app.log.warn({ err: error }, "Could not list scheduled X syncs"));
  }, env.SYNC_INTERVAL_SECONDS * 1000);
  syncTimer.unref();

  app.log.info(
    {
      accounts: [
        ...accounts.map((account) => ({ id: account.id, username: account.username })),
        ...(await connectionService.list()).map((connection) => ({
          id: connection.id,
          username: connection.username,
        })),
      ],
      api_keys_configured: apiKeyStore.size,
      require_https: env.REQUIRE_HTTPS,
      cache_ttl_seconds: env.CACHE_TTL_SECONDS,
      docs_enabled: env.ENABLE_DOCS,
    },
    "Starting X Analytics API",
  );

  await app.listen({ host: env.HOST, port: env.PORT });

  // Render sends SIGTERM on deploy and on scale-down; drain in-flight requests.
  let shuttingDown = false;
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      clearInterval(syncTimer);
      app.log.info({ signal }, "Shutting down");
      app
        .close()
        .then(() => repository.close())
        .then(() => process.exit(0))
        .catch((error) => {
          app.log.error({ err: error }, "Error during shutdown");
          process.exit(1);
        });
    });
  }
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    // Misconfiguration is the common failure; a stack trace only hides the fix.
    console.error(`\nConfiguration error\n\n${error.message}\n`);
    process.exit(1);
  }
  console.error(error);
  process.exit(1);
});
