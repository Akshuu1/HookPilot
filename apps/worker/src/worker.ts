import { Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { env } from './config/env.js';
import { logger } from './config/logger.js';

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

  const worker = new Worker(
    queueName,
    async (job: Job) => {
      logger.info({ jobId: job.id, name: job.name }, 'Processing delivery job');
      return { status: 'processed' };
    },
    {
      connection,
      concurrency: env.CONCURRENCY,
    },
  );

  worker.on('ready', () => {
    logger.info('worker ready');
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
    logger.info('Delivery worker closed successfully');
  };

  return { worker, connection, close };
}
