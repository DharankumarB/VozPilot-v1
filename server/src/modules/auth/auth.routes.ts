import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth';
import {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  clearAuthCookies,
  setAuthCookies,
} from '../../lib/cookies';
import { signAccessToken, signRefreshToken, verifyRefreshToken } from '../../lib/tokens';
import { UnauthorizedError } from '../../lib/errors';
import * as authService from './auth.service';

const router = Router();

const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(128, 'Password must be under 128 characters');

const registerSchema = z.object({
  name: z.string().trim().min(2, 'Name must be at least 2 characters').max(80),
  email: z.string().trim().toLowerCase().email('Enter a valid email address').max(254),
  password: passwordSchema,
});

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email address').max(254),
  password: z.string().min(1, 'Password is required').max(128),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required').max(128),
  newPassword: passwordSchema,
});

router.post('/register', async (req, res, next) => {
  try {
    const body = registerSchema.parse(req.body);
    const user = await authService.register(body);
    setAuthCookies(res, signAccessToken(user.id), signRefreshToken(user.id));
    res.status(201).json({ data: { user } });
  } catch (error) {
    next(error);
  }
});

router.post('/login', async (req, res, next) => {
  try {
    const body = loginSchema.parse(req.body);
    const user = await authService.login(body);
    setAuthCookies(res, signAccessToken(user.id), signRefreshToken(user.id));
    res.json({ data: { user } });
  } catch (error) {
    next(error);
  }
});

router.post('/logout', (req, res) => {
  clearAuthCookies(res);
  res.json({ data: { ok: true } });
});

/**
 * Exchange a valid refresh cookie for a new access cookie (and rotate the
 * refresh cookie). Called automatically by the client on bootstrap/401.
 */
router.post('/refresh', async (req, res, next) => {
  try {
    const token = req.cookies?.[REFRESH_COOKIE] as string | undefined;
    if (!token) {
      throw new UnauthorizedError('No active session.', 'no_session');
    }
    let payload;
    try {
      payload = verifyRefreshToken(token);
    } catch {
      throw new UnauthorizedError('Session expired. Please sign in again.', 'session_expired');
    }

    const user = await authService.getUserForRefresh(payload.sub);
    if (!user) {
      clearAuthCookies(res);
      throw new UnauthorizedError('Account no longer exists.', 'invalid_session');
    }

    setAuthCookies(res, signAccessToken(user.id), signRefreshToken(user.id));
    res.json({ data: { user } });
  } catch (error) {
    next(error);
  }
});

router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const user = await authService.getUserById(req.auth!.userId);
    if (!user) {
      clearAuthCookies(res);
      throw new UnauthorizedError('Account no longer exists.', 'invalid_session');
    }
    res.json({ data: { user } });
  } catch (error) {
    next(error);
  }
});

router.post('/change-password', requireAuth, async (req, res, next) => {
  try {
    const body = changePasswordSchema.parse(req.body);
    await authService.changePassword(req.auth!.userId, body.currentPassword, body.newPassword);
    res.json({ data: { ok: true } });
  } catch (error) {
    next(error);
  }
});

export default router;
