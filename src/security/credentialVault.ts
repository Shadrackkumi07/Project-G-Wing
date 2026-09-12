import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { ConfigError } from "../lib/errors.js";
import type { Repository } from "../storage/repository.js";

export interface XCredentials {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  scope?: string;
}

export class CredentialVault {
  private readonly key: Buffer;

  constructor(
    private readonly repository: Repository,
    masterKey: string | undefined,
  ) {
    if (!masterKey || masterKey.length < 32) {
      throw new ConfigError("CREDENTIAL_ENCRYPTION_KEY must contain at least 32 characters.");
    }
    this.key = createHash("sha256").update(masterKey, "utf8").digest();
  }

  store<T>(credentials: T, existingId?: string): string {
    const now = new Date().toISOString();
    const id = existingId ?? `secret_${randomUUID()}`;
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(credentials), "utf8"),
      cipher.final(),
    ]);
    this.repository.saveSecret({
      id,
      algorithm: "aes-256-gcm",
      iv: iv.toString("base64"),
      auth_tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
      created_at: this.repository.getSecret(id)?.created_at ?? now,
      updated_at: now,
    });
    return id;
  }

  read<T = XCredentials>(id: string): T {
    const secret = this.repository.getSecret(id);
    if (!secret) throw new ConfigError(`Credential secret ${id} does not exist.`);
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(secret.iv, "base64"));
    decipher.setAuthTag(Buffer.from(secret.auth_tag, "base64"));
    return JSON.parse(
      Buffer.concat([
        decipher.update(Buffer.from(secret.ciphertext, "base64")),
        decipher.final(),
      ]).toString("utf8"),
    ) as T;
  }
}
