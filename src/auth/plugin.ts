import type { onRequestHookHandler } from "fastify";
import type { ApiKeyStore } from "./apiKey.js";
import { extractBearerToken } from "./apiKey.js";
import { httpsRequired, unauthorized } from "../lib/errors.js";

declare module "fastify" {
  interface FastifyRequest {
    /** Short non-reversible id of the API key that authenticated this request. */
    apiKeyId?: string;
  }
}

export interface AuthHookOptions {
  store: ApiKeyStore;
  requireHttps: boolean;
}

/**
 * Guards a route with `Authorization: Bearer <api-key>` and, in production,
 * with a transport check so a key can never be accepted over plaintext HTTP.
 */
export function createAuthHook({ store, requireHttps }: AuthHookOptions): onRequestHookHandler {
  return async function authenticate(request, reply) {
    if (requireHttps && request.protocol !== "https") {
      throw httpsRequired();
    }

    const presented = extractBearerToken(request.headers.authorization);
    if (!presented) {
      // RFC 6750: advertise the scheme so clients know what to send.
      reply.header("WWW-Authenticate", 'Bearer realm="x-analytics-api"');
      throw unauthorized("Missing Authorization header. Send: Authorization: Bearer <api-key>");
    }

    const keyId = store.verify(presented);
    if (!keyId) {
      reply.header("WWW-Authenticate", 'Bearer realm="x-analytics-api", error="invalid_token"');
      throw unauthorized("The provided API key is not recognised.");
    }

    request.apiKeyId = keyId;
  };
}
