import fs from 'fs';
import path from 'path';
import express, { type Express } from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { createApiRouter } from './routes';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { isProduction } from './config/env';

const repoRoot = path.resolve(__dirname, '../..');
const clientDist = path.join(repoRoot, 'client', 'dist');

export function createApp(): Express {
  const app = express();

  // Behind the Arena preview proxy — required for secure cookies.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(
    helmet({
      contentSecurityPolicy: isProduction
        ? {
            directives: {
              defaultSrc: ["'self'"],
              baseUri: ["'self'"],
              fontSrc: ["'self'", 'data:'],
              formAction: ["'self'"],
              frameAncestors: ["'self'"],
              imgSrc: ["'self'", 'data:'],
              objectSrc: ["'none'"],
              scriptSrc: ["'self'"],
              styleSrc: ["'self'", "'unsafe-inline'"],
              upgradeInsecureRequests: null,
            },
          }
        : false,
    }),
  );

  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  // Request log (development only).
  if (!isProduction) {
    app.use((req, _res, next) => {
      console.log(`[api] ${req.method} ${req.originalUrl}`);
      next();
    });
  }

  app.use('/api', createApiRouter());

  // Serve the built client when available (production preview mode).
  const hasBuiltClient = fs.existsSync(path.join(clientDist, 'index.html'));
  if (hasBuiltClient) {
    app.use(
      express.static(clientDist, {
        index: false,
        maxAge: '1h',
        setHeaders: (res, filePath) => {
          if (filePath.endsWith('index.html')) res.setHeader('Cache-Control', 'no-cache');
        },
      }),
    );
    // SPA fallback for client-side routes (GET only, never for /api).
    app.use((req, res, next) => {
      if (req.method !== 'GET' || req.path.startsWith('/api')) {
        next();
        return;
      }
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(path.join(clientDist, 'index.html'));
    });
  } else if (isProduction) {
    app.get('/', (_req, res) => {
      res
        .status(503)
        .send('VozPilot client has not been built yet. Run: npm run build');
    });
  }

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
