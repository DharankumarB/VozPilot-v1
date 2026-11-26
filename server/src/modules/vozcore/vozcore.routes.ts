import { Router, type NextFunction, type Request, type Response } from 'express';
import { env } from '../../config/env';
import { requireAuth } from '../../middleware/auth';
import { AppError } from '../../lib/errors';

/**
 * VozCore proxy — forwards /api/vozcore/* to the Python orchestration
 * engine (FastAPI + LangGraph) on the internal port.
 *
 * Authentication happens here (cookie session) AND again in the Python
 * service (same JWT secret), so the engine is safe even if reached
 * directly on loopback. The engine never serves the public port.
 */
const router = Router();
router.use(requireAuth);

const ENGINE = `http://127.0.0.1:${env.VOZCORE_PORT}`;
const NON_BODY_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

async function proxyToEngine(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const init: {
      method: string;
      headers: Record<string, string>;
      body?: string;
    } = {
      method: req.method,
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        cookie: (req.headers.cookie as string | undefined) ?? '',
        'x-vozpilot-user': req.auth!.userId,
      },
    };
    if (!NON_BODY_METHODS.has(req.method)) {
      init.body = JSON.stringify(req.body ?? {});
    }

    // Strip the public prefix: Node owns /api/vozcore, the engine serves /…
    const PREFIX = '/api/vozcore';
    const original = req.originalUrl;
    const suffix = original.startsWith(PREFIX)
      ? original.slice(PREFIX.length) || '/'
      : original;

    const upstream = await fetch(`${ENGINE}${suffix}`, init);
    const text = await upstream.text();
    res.status(upstream.status);
    const contentType = upstream.headers.get('content-type');
    if (contentType) res.setHeader('content-type', contentType);
    res.send(text);
  } catch {
    next(
      new AppError(
        503,
        'vozcore_unavailable',
        'The VozCore engine is not running. Start it with `npm run vozcore` and try again.',
      ),
    );
  }
}

// Middleware form (no wildcard path) so Express 5 route syntax is never a issue.
router.use((req, res, next) => {
  void proxyToEngine(req, res, next);
});

export default router;
