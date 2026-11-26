import type { NextFunction, Request, Response } from 'express';
import { UnauthorizedError } from '../lib/errors';
import { ACCESS_COOKIE } from '../lib/cookies';
import { verifyAccessToken } from '../lib/tokens';

export interface AuthContext {
  userId: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

/** Reject requests without a valid access token cookie. */
export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const token = req.cookies?.[ACCESS_COOKIE] as string | undefined;
  if (!token) {
    next(new UnauthorizedError('Authentication required.'));
    return;
  }
  try {
    const payload = verifyAccessToken(token);
    req.auth = { userId: payload.sub };
    next();
  } catch {
    next(new UnauthorizedError('Session expired. Please sign in again.', 'session_expired'));
  }
}
