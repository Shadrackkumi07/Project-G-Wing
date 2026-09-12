import { describe, expect, it } from "vitest";
import { loadAccounts } from "../src/config/accounts.js";
import { loadEnv } from "../src/config/env.js";
import { ConfigError } from "../src/lib/errors.js";

describe("loadAccounts", () => {
  it("reads numbered slots and defaults the id and label from the handle", () => {
    const accounts = loadAccounts({
      X_ACCOUNT_1_USERNAME: "@FirstHandle",
      X_ACCOUNT_1_BEARER_TOKEN: "token-one",
      X_ACCOUNT_2_USERNAME: "second_handle",
      X_ACCOUNT_2_LABEL: "Brand account",
      X_ACCOUNT_2_ID: "brand",
      X_ACCOUNT_2_BEARER_TOKEN: "token-two",
    });

    expect(accounts).toEqual([
      {
        id: "firsthandle",
        label: "@FirstHandle",
        username: "FirstHandle",
        bearerToken: "token-one",
      },
      { id: "brand", label: "Brand account", username: "second_handle", bearerToken: "token-two" },
    ]);
  });

  it("orders slots numerically rather than lexicographically", () => {
    const accounts = loadAccounts({
      X_BEARER_TOKEN: "shared",
      X_ACCOUNT_1_USERNAME: "one",
      X_ACCOUNT_2_USERNAME: "two",
      X_ACCOUNT_10_USERNAME: "ten",
    });

    expect(accounts.map((account) => account.username)).toEqual(["one", "two", "ten"]);
  });

  it("shares X_BEARER_TOKEN across slots that do not define their own", () => {
    const accounts = loadAccounts({
      X_BEARER_TOKEN: "shared",
      X_ACCOUNT_1_USERNAME: "one",
      X_ACCOUNT_2_USERNAME: "two",
      X_ACCOUNT_2_BEARER_TOKEN: "own",
    });

    expect(accounts.map((account) => account.bearerToken)).toEqual(["shared", "own"]);
  });

  it("accepts the single-account shorthand", () => {
    const accounts = loadAccounts({ X_USERNAME: "solo", X_BEARER_TOKEN: "shared" });
    expect(accounts).toEqual([
      { id: "solo", label: "@solo", username: "solo", bearerToken: "shared" },
    ]);
  });

  it("rejects a configuration with no accounts", () => {
    expect(() => loadAccounts({})).toThrow(ConfigError);
  });

  it("rejects an account with no reachable token", () => {
    expect(() => loadAccounts({ X_ACCOUNT_1_USERNAME: "one" })).toThrow(/No Bearer token/);
  });

  it("rejects duplicate account ids", () => {
    expect(() =>
      loadAccounts({
        X_BEARER_TOKEN: "shared",
        X_ACCOUNT_1_USERNAME: "one",
        X_ACCOUNT_1_ID: "same",
        X_ACCOUNT_2_USERNAME: "two",
        X_ACCOUNT_2_ID: "same",
      }),
    ).toThrow(/Duplicate account id/);
  });

  it("rejects an id that would not be safe in a URL path", () => {
    expect(() =>
      loadAccounts({
        X_BEARER_TOKEN: "shared",
        X_ACCOUNT_1_USERNAME: "one",
        X_ACCOUNT_1_ID: "not/valid",
      }),
    ).toThrow(/Invalid account id/);
  });

  it("rejects a slot whose username is blank", () => {
    expect(() => loadAccounts({ X_BEARER_TOKEN: "shared", X_ACCOUNT_1_USERNAME: "   " })).toThrow(
      /is set but empty/,
    );
  });
});

describe("loadEnv", () => {
  it("applies defaults", () => {
    const env = loadEnv({});
    expect(env.PORT).toBe(3000);
    expect(env.NODE_ENV).toBe("development");
    expect(env.X_API_BASE_URL).toBe("https://api.x.com/2");
    expect(env.CACHE_TTL_SECONDS).toBe(300);
  });

  it("requires HTTPS in production but not in development", () => {
    expect(loadEnv({ NODE_ENV: "production" }).REQUIRE_HTTPS).toBe(true);
    expect(loadEnv({ NODE_ENV: "development" }).REQUIRE_HTTPS).toBe(false);
  });

  it("lets an explicit REQUIRE_HTTPS override the per-environment default", () => {
    expect(loadEnv({ NODE_ENV: "production", REQUIRE_HTTPS: "false" }).REQUIRE_HTTPS).toBe(false);
    expect(loadEnv({ NODE_ENV: "development", REQUIRE_HTTPS: "true" }).REQUIRE_HTTPS).toBe(true);
  });

  it("coerces numeric and boolean strings", () => {
    const env = loadEnv({ PORT: "8080", TRUST_PROXY: "no", ANALYTICS_TWEET_LIMIT: "25" });
    expect(env.PORT).toBe(8080);
    expect(env.TRUST_PROXY).toBe(false);
    expect(env.ANALYTICS_TWEET_LIMIT).toBe(25);
  });

  it("rejects values outside the supported range", () => {
    expect(() => loadEnv({ PORT: "not-a-port" })).toThrow(ConfigError);
    // X caps a single page of user posts at 100.
    expect(() => loadEnv({ ANALYTICS_TWEET_LIMIT: "500" })).toThrow(ConfigError);
  });
});
