import express from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import type { Config } from './config.js';
import { authRouter } from './auth/routes.js';
import { requireAuth } from './auth/session.js';
import { kitsRouter } from './kits/routes.js';
import { errorHandler } from './errors.js';
import type { JobRunner } from './jobs/runner.js';

export function createApp(config: Config, runner: JobRunner) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(helmet());
  app.use(express.json({ limit: '300kb' }));
  app.use(cookieParser());

  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.use('/api/auth', authRouter(config));
  app.use('/api/kits', requireAuth(config), kitsRouter(config, runner));
  app.use('/api', (_req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No such endpoint' } }));
  app.use(errorHandler);
  return app;
}
