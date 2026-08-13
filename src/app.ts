import express, { type NextFunction, type Request, type Response } from 'express';

import webhookRouter from './routes/webhook.js';
import { logger } from './utils/logger.js';

export function createApp() {
  const app = express();

  app.disable('x-powered-by');

  app.get('/', (_req: Request, res: Response) => {
    res.status(200).json({
      name: 'codex-postback-action',
      status: 'ok',
      webhook: '/webhook'
    });
  });

  app.get('/health', (_req: Request, res: Response) => {
    res.status(200).json({ status: 'ok' });
  });

  app.use('/webhook', webhookRouter);

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const message = error instanceof Error ? error.message : 'Internal Server Error';

    logger.error('Unhandled request error', { message });
    res.status(500).json({ error: 'Internal Server Error' });
  });

  return app;
}

export const app = createApp();
