// SPDX-License-Identifier: MIT
/**
 * Application error model shared across MediaNexus.
 * All errors carry an `errorCode` that the API layer maps to the wire envelope
 * `{ error: { code, message, details } }` (see docs/architecture/api.md §3).
 */
export type ErrorCode =
  | "VALIDATION_ERROR"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "UNPROCESSABLE"
  | "RATE_LIMITED"
  | "INTERNAL"
  | "NOT_IMPLEMENTED";

export interface ApiErrorOptions {
  code: ErrorCode;
  message: string;
  details?: unknown;
  cause?: unknown;
}

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;
  readonly statusCode: number;

  constructor(opts: ApiErrorOptions) {
    super(opts.message);
    this.name = "ApiError";
    this.code = opts.code;
    this.details = opts.details;
    this.cause = opts.cause;
    this.statusCode = statusForCode(opts.code);
  }

  static notFound(entity: string, id?: string | number): ApiError {
    return new ApiError({
      code: "NOT_FOUND",
      message: id == null ? `${entity} not found` : `${entity} ${id} not found`,
    });
  }
}

export function statusForCode(code: ErrorCode): number {
  switch (code) {
    case "VALIDATION_ERROR": return 400;
    case "UNAUTHORIZED": return 401;
    case "FORBIDDEN": return 403;
    case "NOT_FOUND": return 404;
    case "CONFLICT": return 409;
    case "UNPROCESSABLE": return 422;
    case "RATE_LIMITED": return 429;
    case "NOT_IMPLEMENTED": return 501;
    default: return 500;
  }
}

export const notFound = (entity: string, id?: string | number) =>
  new ApiError({
    code: "NOT_FOUND",
    message: id == null ? `${entity} not found` : `${entity} ${id} not found`,
  });
