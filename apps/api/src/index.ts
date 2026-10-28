import { createServer } from 'node:http';
import { app } from './app.js';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { connectDatabase, disconnectDatabase } from './config/db.js';
import { getRedisClient, disconnectRedis } from './config/redis.js';

async function bootstrap(): Promise<void> {
  try {
    // Initialize DB & Redis
    await connectDatabase().catch((err) => {
      logger.warn({ err }, 'MongoDB initial connection failed, will retry in background');
    });

    const redis = getRedisClient();
    redis.ping().catch((err) => {
      logger.warn({ err }, 'Redis initial ping failed, will retry in background');
    });

    const server = createServer(app);

    server.listen(env.PORT, () => {
      logger.info({ port: env.PORT, env: env.NODE_ENV }, 'HookPilot API listening');
    });

    // Graceful shutdown
    const shutdown = async (signal: string) => {
      logger.info({ signal }, 'Shutdown signal received, closing resources gracefully...');

      server.close(async () => {
        logger.info('HTTP server closed');
        await Promise.allSettled([disconnectDatabase(), disconnectRedis()]);
        logger.info('All connections closed. Exiting process.');
        process.exit(0);
      });

      // Force exit after 10s if graceful shutdown hangs
      setTimeout(() => {
        logger.error('Forced shutdown due to timeout');
        process.exit(1);
      }, 10000).unref();
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  } catch (err) {
    logger.fatal({ err }, 'Fatal bootstrap failure in API');
    process.exit(1);
  }
}

bootstrap();
