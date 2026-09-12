import { ConfigError } from "../lib/errors.js";

export interface XAccountConfig {
  /** URL-safe identifier used in endpoint paths, e.g. /v1/accounts/main. */
  id: string;
  /** Human-readable name shown in responses. */
  label: string;
  /** X handle without the leading "@". */
  username: string;
  /** App-only or user-context Bearer token used for this account's requests. */
  bearerToken: string;
}

/** Public view of an account — never carries the token. */
export type PublicXAccount = Omit<XAccountConfig, "bearerToken">;

export function toPublicAccount(account: XAccountConfig): PublicXAccount {
  return { id: account.id, label: account.label, username: account.username };
}

const SLOT_PATTERN = /^X_ACCOUNT_([A-Za-z0-9]+)_USERNAME$/;
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeUsername(value: string): string {
  return value.trim().replace(/^@/, "");
}

function read(source: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = source[key];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * Accounts are configured as numbered slots so they can be entered one variable
 * at a time in a hosting dashboard:
 *
 *   X_ACCOUNT_1_USERNAME=myhandle
 *   X_ACCOUNT_1_LABEL=Personal
 *   X_ACCOUNT_1_ID=personal
 *   X_ACCOUNT_1_BEARER_TOKEN=...     (falls back to X_BEARER_TOKEN)
 *
 * A single account may also be configured with just X_USERNAME + X_BEARER_TOKEN.
 */
export function loadAccounts(
  source: NodeJS.ProcessEnv = process.env,
  options: { allowEmpty?: boolean } = {},
): XAccountConfig[] {
  const sharedToken = read(source, "X_BEARER_TOKEN");
  const slots = Object.keys(source)
    .map((key) => SLOT_PATTERN.exec(key)?.[1])
    .filter((slot): slot is string => slot !== undefined)
    .sort((a, b) => a.localeCompare(b, "en", { numeric: true }));

  const accounts: XAccountConfig[] = [];

  for (const slot of slots) {
    const username = normalizeUsername(read(source, `X_ACCOUNT_${slot}_USERNAME`) ?? "");
    if (username === "") {
      throw new ConfigError(`X_ACCOUNT_${slot}_USERNAME is set but empty.`);
    }

    const bearerToken = read(source, `X_ACCOUNT_${slot}_BEARER_TOKEN`) ?? sharedToken;
    if (!bearerToken) {
      throw new ConfigError(
        `No Bearer token for account slot ${slot}. Set X_ACCOUNT_${slot}_BEARER_TOKEN, ` +
          `or set X_BEARER_TOKEN to share one app's token across all accounts.`,
      );
    }

    const id = read(source, `X_ACCOUNT_${slot}_ID`)?.toLowerCase() ?? slugify(username);
    if (!ID_PATTERN.test(id)) {
      throw new ConfigError(
        `Invalid account id "${id}" for slot ${slot}. Use lowercase letters, digits and ` +
          `hyphens (max 63 characters, starting with a letter or digit).`,
      );
    }

    accounts.push({
      id,
      label: read(source, `X_ACCOUNT_${slot}_LABEL`) ?? `@${username}`,
      username,
      bearerToken,
    });
  }

  const singleUsername = normalizeUsername(read(source, "X_USERNAME") ?? "");
  if (accounts.length === 0 && singleUsername !== "") {
    if (!sharedToken) {
      throw new ConfigError("X_USERNAME is set but X_BEARER_TOKEN is missing.");
    }
    accounts.push({
      id: slugify(singleUsername),
      label: `@${singleUsername}`,
      username: singleUsername,
      bearerToken: sharedToken,
    });
  }

  if (accounts.length === 0 && !options.allowEmpty) {
    throw new ConfigError(
      "No X accounts configured. Set X_ACCOUNT_1_USERNAME (and a Bearer token) to expose " +
        "at least one account. See .env.example.",
    );
  }

  const seen = new Set<string>();
  for (const account of accounts) {
    if (seen.has(account.id)) {
      throw new ConfigError(
        `Duplicate account id "${account.id}". Give each account a unique X_ACCOUNT_<n>_ID.`,
      );
    }
    seen.add(account.id);
  }

  return accounts;
}
