import { createHash, randomBytes } from "node:crypto";
import type { Env } from "../config/env.js";
import { ApiError } from "../lib/errors.js";
import type { CredentialVault } from "../security/credentialVault.js";
import type { Repository } from "../storage/repository.js";
import type { XClient } from "../x/client.js";
import type { ConnectionService, SafeConnection } from "./connectionService.js";

const AUTHORIZE_URL = "https://x.com/i/oauth2/authorize";
const STATE_TTL_MS = 10 * 60_000;

function base64Url(bytes: Buffer): string {
  return bytes.toString("base64url");
}

function challenge(verifier: string): string {
  return createHash("sha256").update(verifier, "utf8").digest("base64url");
}

export class XOAuthService {
  constructor(
    private readonly repository: Repository,
    private readonly vault: CredentialVault,
    private readonly client: XClient,
    private readonly connections: ConnectionService,
    private readonly env: Pick<
      Env,
      "X_CLIENT_ID" | "X_CLIENT_SECRET" | "X_OAUTH_REDIRECT_URI" | "X_OAUTH_SCOPES"
    >,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async begin(): Promise<{ authorization_url: string; expires_at: string }> {
    if (!this.env.X_CLIENT_ID || !this.env.X_OAUTH_REDIRECT_URI) {
      throw new ApiError(
        503,
        "oauth_not_configured",
        "Set X_CLIENT_ID and X_OAUTH_REDIRECT_URI before starting OAuth.",
      );
    }
    const state = base64Url(randomBytes(32));
    const verifier = base64Url(randomBytes(64));
    const expiresAt = new Date(this.now().getTime() + STATE_TTL_MS).toISOString();
    const verifierSecret = await this.vault.store({ verifier });
    await this.repository.saveOAuthState({
      state,
      verifier_secret_reference: verifierSecret,
      expires_at: expiresAt,
      created_at: this.now().toISOString(),
    });

    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", this.env.X_CLIENT_ID);
    url.searchParams.set("redirect_uri", this.env.X_OAUTH_REDIRECT_URI);
    url.searchParams.set("scope", this.env.X_OAUTH_SCOPES);
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", challenge(verifier));
    url.searchParams.set("code_challenge_method", "S256");
    return { authorization_url: url.toString(), expires_at: expiresAt };
  }

  async complete(input: {
    code?: string;
    state?: string;
    error?: string;
  }): Promise<SafeConnection> {
    if (input.error) {
      throw new ApiError(400, "bad_request", "X authorization was declined or cancelled.");
    }
    if (!input.code || !input.state) {
      throw new ApiError(
        400,
        "oauth_state_invalid",
        "OAuth callback is missing its code or state.",
      );
    }
    const pending = await this.repository.takeOAuthState(input.state);
    if (!pending || Date.parse(pending.expires_at) <= this.now().getTime()) {
      if (pending) await this.repository.deleteSecret(pending.verifier_secret_reference);
      throw new ApiError(
        400,
        "oauth_state_invalid",
        "OAuth state is invalid or expired. Start again.",
      );
    }
    const { verifier } = await this.vault.read<{ verifier: string }>(
      pending.verifier_secret_reference,
    );
    await this.repository.deleteSecret(pending.verifier_secret_reference);
    const tokens = await this.client.exchangeAuthorizationCode({
      code: input.code,
      codeVerifier: verifier,
      redirectUri: this.env.X_OAUTH_REDIRECT_URI!,
      clientId: this.env.X_CLIENT_ID!,
      clientSecret: this.env.X_CLIENT_SECRET,
    });
    return this.connections.create({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      token_expires_at: tokens.expires_in
        ? new Date(this.now().getTime() + tokens.expires_in * 1000).toISOString()
        : undefined,
      token_type: tokens.token_type,
      scope: tokens.scope,
    });
  }
}
