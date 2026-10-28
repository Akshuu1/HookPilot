import { createDeliveryWorker } from './worker.js';
import { logger } from './config/logger.js';

async function bootstrap(): Promise<void> {
  try {
    const { close } = createDeliveryWorker();

    const shutdown = async (signal: string) => {
      logger.info({ signal }, 'Shutdown signal received in worker, closing gracefully...');
      try {
        await close();
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
