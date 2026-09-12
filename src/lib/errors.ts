export type ErrorCode =
  | "bad_request"
  | "unauthorized"
  | "forbidden"
  | "https_required"
  | "not_found"
  | "rate_limited"
  | "upstream_unauthorized"
  | "upstream_rate_limited"
  | "upstream_unavailable"
  | "upstream_error"
  | "duplicate_connection"
  | "account_mismatch"
  | "refresh_unavailable"
  | "token_refresh_failed"
  | "oauth_not_configured"
  | "oauth_exchange_failed"
  | "oauth_state_invalid"
  | "internal_error";

export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: ErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(
    statusCode: number,
    code: ErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }

  toJSON(): { error: { code: ErrorCode; message: string; details?: Record<string, unknown> } } {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details ? { details: this.details } : {}),
      },
    };
  }
}

export const unauthorized = (message = "A valid Bearer API key is required.") =>
  new ApiError(401, "unauthorized", message);

export const httpsRequired = () =>
  new ApiError(
    403,
    "https_required",
    "This API only accepts requests over HTTPS. Retry using an https:// URL.",
  );

export const notFound = (message: string, details?: Record<string, unknown>) =>
  new ApiError(404, "not_found", message, details);

/**
 * Env/config problems are fatal at boot rather than per-request, so they are a
 * distinct type: the process should refuse to start instead of serving errors.
 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}
