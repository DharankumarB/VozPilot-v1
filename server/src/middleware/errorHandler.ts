import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { AppError } from '../lib/errors';
import { isProduction } from '../config/env';

interface PgLikeError {
  code?: string;
  constraint?: string;
  detail?: string;
}

/** Map PostgreSQL driver errors to honest, friendly API errors. */
function mapDatabaseError(error: PgLikeError): AppError | null {
  switch (error.code) {
    case '23505': // unique_violation
      return new AppError(409, 'conflict', 'A record with those details already exists.', {
        constraint: error.constraint,
      });
    case '23503': // foreign_key_violation
      return new AppError(400, 'invalid_reference', 'A referenced record does not exist.');
    case '23514': // check_violation
      return new AppError(422, 'validation_error', 'One of the submitted values is not allowed.');
    case '22P02': // invalid_text_representation
      return new AppError(422, 'validation_error', 'One of the submitted values has an invalid format.');
    default:
      return null;
  }
}

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    error: { code: 'not_found', message: `No API route matches ${req.method} ${req.originalUrl}` },
  });
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(error: unknown, req: Request, res: Response, _next: NextFunction): void {
  if (res.headersSent) {
    return;
  }

  if (error instanceof ZodError) {
    res.status(422).json({
      error: {
        code: 'validation_error',
        message: 'Some submitted values are invalid.',
        details: error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      },
    });
    return;
  }

  if (error instanceof AppError) {
    res.status(error.status).json({
      error: { code: error.code, message: error.message, details: error.details },
    });
    return;
  }

  const pgError = error as PgLikeError | undefined;
  if (pgError && typeof pgError.code === 'string' && pgError.code.length === 5) {
    const mapped = mapDatabaseError(pgError);
    if (mapped) {
      res.status(mapped.status).json({
        error: { code: mapped.code, message: mapped.message, details: mapped.details },
      });
      return;
    }
  }

  // express.json parse errors
  const bodyError = error as { type?: string };
  if (bodyError?.type === 'entity.parse.failed') {
    res.status(400).json({ error: { code: 'invalid_json', message: 'Request body is not valid JSON.' } });
    return;
  }
  if (bodyError?.type === 'entity.too.large') {
    res.status(413).json({ error: { code: 'payload_too_large', message: 'Request body is too large.' } });
    return;
  }

  console.error(`[api] Unhandled error on ${req.method} ${req.originalUrl}:`, error);
  res.status(500).json({
    error: {
      code: 'internal_error',
      message: isProduction
        ? 'Something went wrong on the server. Please try again.'
        : error instanceof Error
          ? error.message
          : 'Unexpected server error.',
    },
  });
}
