import type { Response } from 'express';
import { env, isProduction } from '../config/env';

export const ACCESS_COOKIE = 'vp_at';
export const REFRESH_COOKIE = 'vp_refresh';
export const REFRESH_COOKIE_PATH = '/api/auth';

function parseTtlToSeconds(ttl: string, fallbackSeconds: number): number {
  const match = /^(\d+)([smhd])$/.exec(ttl.trim());
  if (!match) return fallbackSeconds;
  const value = Number(match[1]);
  const unit = match[2];
  const factors: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };
  return value * (factors[unit] ?? 1);
}

export function setAuthCookies(res: Response, accessToken: string, refreshToken: string): void {
  const accessMaxAge = parseTtlToSeconds(env.ACCESS_TOKEN_TTL, 900);
  const refreshMaxAge = parseTtlToSeconds(env.REFRESH_TOKEN_TTL, 604800);

  res.cookie(ACCESS_COOKIE, accessToken, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProduction,
    path: '/',
    maxAge: accessMaxAge * 1000,
  });
  res.cookie(REFRESH_COOKIE, refreshToken, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProduction,
    path: REFRESH_COOKIE_PATH,
    maxAge: refreshMaxAge * 1000,
  });
}

export function clearAuthCookies(res: Response): void {
  const options = { path: '/', sameSite: 'lax' as const, secure: isProduction, httpOnly: true };
  res.clearCookie(ACCESS_COOKIE, options);
  res.clearCookie(REFRESH_COOKIE, { ...options, path: REFRESH_COOKIE_PATH });
}
