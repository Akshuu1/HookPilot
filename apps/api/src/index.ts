import { createServer } from 'node:http';
import { app } from './app.js';
import { env, logFeatureStatus } from './config/env.js';
import { logger } from './config/logger.js';
import { connectDatabase, disconnectDatabase } from './config/db.js';
import { getRedisClient, disconnectRedis } from './config/redis.js';
import { createSocketServer } from './services/socket.service.js';

async function bootstrap(): Promise<void> {
  try {
    const port = Number(process.env.PORT) || env.PORT;
    const server = createServer(app);
    const io = createSocketServer(server);

    // Bind HTTP server immediately to 0.0.0.0 and port so /health is reachable instantly
    server.listen(port, '0.0.0.0', () => {
      logger.info({ port, env: env.NODE_ENV, host: '0.0.0.0' }, 'HookPilot API listening');
      logFeatureStatus(logger);
    });

    // Initialize DB & Redis in background without blocking server listen
    connectDatabase()
      .then(async () => {
        try {
          const { EndpointModel } = await import('./models/Endpoint.js');
          const { DestinationModel } = await import('./models/Destination.js');
          const legacyEndpoints = await EndpointModel.find({
            destinationUrl: { $exists: true, $ne: '' },
          }).lean();
          let unmigratedCount = 0;
          for (const ep of legacyEndpoints) {
            const destCount = await DestinationModel.countDocuments({ endpointId: ep._id });
            if (destCount === 0) unmigratedCount++;
          }
          if (unmigratedCount > 0) {
            logger.warn(
              { unmigratedEndpoints: unmigratedCount },
              "Un-migrated data detected: endpoints found without Destination records. Please run 'npm run migrate' to backfill.",
            );
          }
        } catch {
          // Non-blocking check
        }
      })
      .catch((err) => {
        logger.warn({ err }, 'MongoDB initial connection failed, will retry in background');
      });

    try {
      const redis = getRedisClient();
      redis.ping().catch((err) => {
        logger.warn({ err }, 'Redis initial ping failed, will retry in background');
      });
    } catch (err) {
      logger.warn({ err }, 'Redis client initialization failed, will retry in background');
    }

    // Graceful shutdown
    const shutdown = async (signal: string) => {
      logger.info({ signal }, 'Shutdown signal received, closing resources gracefully...');

      server.close(async () => {
        logger.info('HTTP server closed');
        await io.cleanup?.();
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
