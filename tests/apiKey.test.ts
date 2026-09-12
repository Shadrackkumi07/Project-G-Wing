import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ApiKeyStore, extractBearerToken } from "../src/auth/apiKey.js";
import { ConfigError } from "../src/lib/errors.js";

const KEY = "test-key-that-is-long-enough-123";
const OTHER_KEY = "second-key-that-is-long-enough-1";
const hashOf = (value: string) => createHash("sha256").update(value).digest("hex");

describe("extractBearerToken", () => {
  it("reads the token from a Bearer header", () => {
    expect(extractBearerToken("Bearer abc123")).toBe("abc123");
  });

  it("accepts any casing of the scheme and extra whitespace", () => {
    expect(extractBearerToken("  bearer   abc123  ")).toBe("abc123");
  });

  it("rejects a missing, empty or non-Bearer header", () => {
    expect(extractBearerToken(undefined)).toBeNull();
    expect(extractBearerToken("Bearer ")).toBeNull();
    expect(extractBearerToken("Basic abc123")).toBeNull();
    expect(extractBearerToken("abc123")).toBeNull();
  });
});

describe("ApiKeyStore", () => {
  it("accepts a key configured as a hash", () => {
    const store = ApiKeyStore.fromEnv({ hashes: hashOf(KEY) });
    expect(store.verify(KEY)).toBe(hashOf(KEY).slice(0, 8));
    expect(store.verify(OTHER_KEY)).toBeNull();
  });

  it("accepts a key configured in plaintext", () => {
    const store = ApiKeyStore.fromEnv({ plaintextKeys: KEY });
    expect(store.verify(KEY)).not.toBeNull();
    expect(store.verify(`${KEY}x`)).toBeNull();
  });

  it("supports several keys from both sources, separated by commas or whitespace", () => {
    const store = ApiKeyStore.fromEnv({
      hashes: `${hashOf(KEY)}, ${hashOf(OTHER_KEY)}`,
      plaintextKeys: "a-third-key-long-enough-for-use",
    });

    expect(store.size).toBe(3);
    expect(store.verify(KEY)).not.toBeNull();
    expect(store.verify(OTHER_KEY)).not.toBeNull();
    expect(store.verify("a-third-key-long-enough-for-use")).not.toBeNull();
  });

  it("never retains the plaintext key", () => {
    const store = ApiKeyStore.fromEnv({ plaintextKeys: KEY });
    expect(JSON.stringify(store)).not.toContain(KEY);
  });

  it("fails closed when nothing is configured", () => {
    expect(() => ApiKeyStore.fromEnv({})).toThrow(/No API keys configured/);
    expect(() => ApiKeyStore.fromEnv({})).toThrow(ConfigError);
  });

  it("rejects a hash that is not a SHA-256 digest", () => {
    expect(() => ApiKeyStore.fromEnv({ hashes: "deadbeef" })).toThrow(/SHA-256 hex digest/);
  });

  it("rejects a plaintext key that is too short to be safe", () => {
    expect(() => ApiKeyStore.fromEnv({ plaintextKeys: "short" })).toThrow(/shorter than 24/);
  });
});
