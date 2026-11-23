/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly errorCode: string;
  public readonly details?: unknown;
  public readonly isOperational: boolean;

  constructor(
    message: string,
    statusCode = 500,
    errorCode = 'INTERNAL_SERVER_ERROR',
    details?: unknown
  ) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.errorCode = errorCode;
    this.details = details;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }
}

export class BadRequestError extends AppError {
  constructor(message: string, errorCode = 'BAD_REQUEST', details?: unknown) {
    super(message, 400, errorCode, details);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required', errorCode = 'AUTHENTICATION_REQUIRED', details?: unknown) {
    super(message, 401, errorCode, details);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Insufficient permissions', errorCode = 'INSUFFICIENT_PERMISSION', details?: unknown) {
    super(message, 403, errorCode, details);
  }
}

export class NotFoundError extends AppError {
  constructor(message: string, errorCode = 'NOT_FOUND', details?: unknown) {
    super(message, 404, errorCode, details);
  }
}

export class ConflictError extends AppError {
  constructor(message: string, errorCode = 'CONFLICT', details?: unknown) {
    super(message, 409, errorCode, details);
  }
}

export class PayloadTooLargeError extends AppError {
  constructor(message = 'Request body exceeds maximum allowed size', errorCode = 'PAYLOAD_TOO_LARGE', details?: unknown) {
    super(message, 413, errorCode, details);
  }
}

export class UnsupportedMediaTypeError extends AppError {
  constructor(message = 'Unsupported Content-Type; application/json required', errorCode = 'UNSUPPORTED_MEDIA_TYPE', details?: unknown) {
    super(message, 415, errorCode, details);
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, 422, 'VALIDATION_ERROR', details);
  }
}

export class TooManyRequestsError extends AppError {
  public readonly retryAfterSeconds: number;

  constructor(
    message = 'Rate limit exceeded',
    retryAfterSeconds = 60,
    errorCode = 'RATE_LIMIT_EXCEEDED',
    details?: unknown
  ) {
    super(message, 429, errorCode, details);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}
