import { Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { deliveryProcessor, type DeliveryJobData } from './processors/delivery.processor.js';
import { closeRedisConnections } from './config/redis.js';

export interface WorkerInstance {
  worker: Worker;
  connection: Redis;
  close: () => Promise<void>;
}

export function createDeliveryWorker(queueName = 'delivery'): WorkerInstance {
  const connection = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    retryStrategy(times) {
      return Math.min(times * 200, 3000);
    },
  });

  connection.on('error', (err) => {
    logger.error({ err }, 'Redis connection error in worker');
  });

  const worker = new Worker<DeliveryJobData>(
    queueName,
    async (job: Job<DeliveryJobData>) => {
      logger.info({ jobId: job.id, name: job.name, data: job.data }, 'Processing delivery job');
      return deliveryProcessor(job);
    },
    {
      connection,
      concurrency: env.CONCURRENCY,
    },
  );

  worker.on('ready', () => {
    logger.info(`worker ready with concurrency ${env.CONCURRENCY}`);
  });

  worker.on('error', (err) => {
    logger.error({ err }, 'BullMQ worker error');
  });

  worker.on('failed', (job, err) => {
    logger.warn({ jobId: job?.id, err }, 'Job failed');
  });

  const close = async () => {
    logger.info('Closing delivery worker...');
    await worker.close();
    await connection.quit();
    await closeRedisConnections();
    logger.info('Delivery worker closed successfully');
  };

  return { worker, connection, close };
}
