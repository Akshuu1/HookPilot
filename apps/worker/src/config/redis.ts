import { Redis } from 'ioredis';
import { Queue } from 'bullmq';
import { env } from './env.js';
import { logger } from './logger.js';

let redisClient: Redis | null = null;
let deliveryQueue: Queue | null = null;

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

export async function closeRedisConnections(): Promise<void> {
  if (deliveryQueue) {
    await deliveryQueue.close();
    deliveryQueue = null;
  }
  if (redisClient) {
    await redisClient.quit();
    redisClient = null;
  }
}
