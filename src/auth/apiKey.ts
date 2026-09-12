import { createHash, timingSafeEqual } from "node:crypto";
import { ConfigError } from "../lib/errors.js";

const HEX_SHA256 = /^[0-9a-f]{64}$/;

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function splitList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

export interface ApiKeyStoreInput {
  /** Comma- or whitespace-separated SHA-256 hex digests of accepted keys. */
  hashes?: string | undefined;
  /** Comma- or whitespace-separated plaintext keys, hashed on load. */
  plaintextKeys?: string | undefined;
}

/**
 * Accepted API keys, held only as SHA-256 digests so a heap dump or log line
 * cannot leak a usable credential.
 */
export class ApiKeyStore {
  private readonly digests: Buffer[];

  private constructor(digests: Buffer[]) {
    this.digests = digests;
  }

  static fromEnv({ hashes, plaintextKeys }: ApiKeyStoreInput): ApiKeyStore {
    const digests: Buffer[] = [];

    for (const hash of splitList(hashes)) {
      const normalized = hash.toLowerCase();
      if (!HEX_SHA256.test(normalized)) {
        throw new ConfigError(
          `API_KEY_HASHES contains "${hash.slice(0, 8)}…", which is not a 64-character ` +
            `SHA-256 hex digest. Generate one with: ` +
            `node -e "console.log(require('crypto').createHash('sha256').update(process.argv[1]).digest('hex'))" YOUR_KEY`,
        );
      }
      digests.push(Buffer.from(normalized, "hex"));
    }

    for (const key of splitList(plaintextKeys)) {
      if (key.length < 24) {
        throw new ConfigError(
          `API_KEYS contains a key shorter than 24 characters. Generate a strong key with: ` +
            `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`,
        );
      }
      digests.push(sha256(key));
    }

    if (digests.length === 0) {
      throw new ConfigError(
        "No API keys configured, so every request would be rejected. Set API_KEY_HASHES " +
          "(preferred) or API_KEYS. See .env.example.",
      );
    }

    return new ApiKeyStore(digests);
  }

  get size(): number {
    return this.digests.length;
  }

  /**
   * Returns a short, non-reversible identifier for the matched key (for logging
   * and rate-limit bucketing), or null when the key is not accepted.
   *
   * Every configured digest is compared with no early exit, so response time
   * does not reveal which key matched or how many keys are configured.
   */
  verify(presentedKey: string): string | null {
    const presented = sha256(presentedKey);
    let matched: Buffer | null = null;

    for (const digest of this.digests) {
      if (timingSafeEqual(presented, digest)) {
        matched = digest;
      }
    }

    return matched ? matched.toString("hex").slice(0, 8) : null;
  }
}

/** Parses an `Authorization: Bearer <key>` header value. */
export function extractBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer[ ]+(.+)$/i.exec(header.trim());
  const token = match?.[1]?.trim();
  return token && token !== "" ? token : null;
}
