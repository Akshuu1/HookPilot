import { Redis } from 'ioredis';
import { Queue } from 'bullmq';
import { env } from './env.js';
import { logger } from './logger.js';

let redisClient: Redis | null = null;
let deliveryQueue: Queue | null = null;
let alertsQueue: Queue | null = null;

export function getRedisClient(): Redis {
  if (!redisClient) {
    redisClient = new Redis(env.REDIS_URL, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
      retryStrategy(times) {
        return Math.min(times * 200, 3000);
      },
    });

    redisClient.on('error', (err) => {
      logger.error({ err }, 'Redis client error in worker');
    });
  }

  return redisClient;
}

export function getDeliveryQueue(): Queue {
  if (!deliveryQueue) {
    deliveryQueue = new Queue('delivery', {
      connection: getRedisClient(),
      defaultJobOptions: {
        removeOnComplete: true,
        removeOnFail: false,
      },
    });

    deliveryQueue.on('error', (err) => {
      logger.error({ err }, 'Delivery queue error in worker');
    });
  }

  return deliveryQueue;
}

export function getAlertsQueue(): Queue {
  if (!alertsQueue) {
    alertsQueue = new Queue('alerts', {
      connection: getRedisClient(),
      defaultJobOptions: {
        attempts: 5,
        backoff: {
          type: 'exponential',
          delay: 1000,
        },
        removeOnComplete: 1000,
        removeOnFail: 5000,
      },
    });

    alertsQueue.on('error', (err) => {
      logger.error({ err }, 'Alerts queue error in worker');
    });
  }

  return alertsQueue;
}

export async function closeRedisConnections(): Promise<void> {
  if (alertsQueue) {
    await alertsQueue.close();
    alertsQueue = null;
  }
  if (deliveryQueue) {
    await deliveryQueue.close();
    deliveryQueue = null;
  }
  if (redisClient) {
    await redisClient.quit();
    redisClient = null;
  }
}
