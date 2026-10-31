import { Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { deliveryProcessor, type DeliveryJobData } from './processors/delivery.processor.js';
import {
  alertNotificationProcessor,
  type AlertJobData,
} from './processors/alert-notification.processor.js';
import { reconcilerService } from './services/reconciler.service.js';
import { alertEvaluatorService } from './services/alert-evaluator.service.js';
import { closeRedisConnections, getDeliveryQueue, getAlertsQueue } from './config/redis.js';

export interface WorkerInstance {
  worker: Worker;
  alertsWorker?: Worker;
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
      if (job.name === 'reconcile') {
        logger.info('Running pending deliveries reconciler');
        return reconcilerService.reconcile();
      }
      logger.info({ jobId: job.id, name: job.name, data: job.data }, 'Processing delivery job');
      return deliveryProcessor(job);
    },
    {
      connection,
      concurrency: env.CONCURRENCY,
    },
  );

  // Alerts Worker on 'alerts' queue
  const alertsWorker = new Worker<AlertJobData>(
    'alerts',
    async (job: Job<AlertJobData>) => {
      if (job.name === 'alerts:evaluate') {
        logger.info('Running recurring alerts:evaluate scheduler');
        return alertEvaluatorService.evaluateAllRules();
      }
      return alertNotificationProcessor(job);
    },
    {
      connection,
      concurrency: 5,
    },
  );

  // Repeatable reconciler job every minute
  try {
    const queue = getDeliveryQueue();
    queue
      .add(
        'reconcile',
        {},
        {
          repeat: { pattern: '* * * * *' },
          jobId: 'reconcile-pending-deliveries',
          removeOnComplete: true,
        },
      )
      .catch(() => {});
  } catch {
    // Non-blocking in offline / test environments
  }

  // Repeatable alerts evaluator job every minute
  try {
    const alertsQueue = getAlertsQueue();
    alertsQueue
      .add(
        'alerts:evaluate',
        {},
        {
          repeat: { pattern: '* * * * *' },
          jobId: 'alerts-evaluator-cron',
          removeOnComplete: true,
        },
      )
      .catch(() => {});
  } catch {
    // Non-blocking in offline / test environments
  }

  worker.on('ready', () => {
    logger.info(`delivery worker ready with concurrency ${env.CONCURRENCY}`);
  });

  alertsWorker.on('ready', () => {
    logger.info('alerts worker ready');
  });

  worker.on('error', (err) => {
    logger.error({ err }, 'BullMQ delivery worker error');
  });

  alertsWorker.on('error', (err) => {
    logger.error({ err }, 'BullMQ alerts worker error');
  });

  worker.on('failed', (job, err) => {
    logger.warn({ jobId: job?.id, err }, 'Delivery job failed');
  });

  alertsWorker.on('failed', (job, err) => {
    logger.warn({ jobId: job?.id, err }, 'Alert job failed');
  });

  const close = async () => {
    logger.info('Closing delivery and alert workers...');
    await worker.close();
    await alertsWorker.close();
    await connection.quit();
    await closeRedisConnections();
    logger.info('Workers closed successfully');
  };

  return { worker, alertsWorker, connection, close };
}
