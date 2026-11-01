import http from 'node:http';
import { createDeliveryWorker } from './worker.js';
import { connectDatabase, disconnectDatabase } from './config/db.js';
import { logger } from './config/logger.js';
import { logWorkerFeatureStatus } from './config/env.js';

async function bootstrap(): Promise<void> {
  try {
    logWorkerFeatureStatus(logger);

    let healthServer: http.Server | null = null;
    if (process.env.WORKER_HEALTH_PORT) {
      const port = Number(process.env.WORKER_HEALTH_PORT);
      healthServer = http.createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', worker: 'running' }));
      });
      healthServer.listen(port, '0.0.0.0', () => {
        logger.info({ port, host: '0.0.0.0' }, 'Worker health server listening');
      });
    }

    await connectDatabase();
    const { close } = createDeliveryWorker();

    const shutdown = async (signal: string) => {
      logger.info({ signal }, 'Shutdown signal received in worker, closing gracefully...');
      try {
        if (healthServer) {
          await new Promise<void>((resolve) => healthServer?.close(() => resolve()));
        }
        await close();
        await disconnectDatabase();
        logger.info('Worker exited gracefully');
        process.exit(0);
      } catch (err) {
        logger.error({ err }, 'Error during worker shutdown');
        process.exit(1);
      }
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  } catch (err) {
    logger.fatal({ err }, 'Fatal bootstrap error in worker');
    process.exit(1);
  }
}

bootstrap();
