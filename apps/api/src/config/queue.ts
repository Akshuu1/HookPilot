import { Queue } from 'bullmq';
import { getRedisClient } from './redis.js';

let deliveryQueue: Queue | null = null;
let alertsQueue: Queue | null = null;

export function getDeliveryQueue(): Queue {
  if (!deliveryQueue) {
    const connection = getRedisClient();
    deliveryQueue = new Queue('delivery', {
      connection,
    });
  }
  return deliveryQueue;
}

export async function closeDeliveryQueue(): Promise<void> {
  if (deliveryQueue) {
    await deliveryQueue.close();
    deliveryQueue = null;
  }
}

export function getAlertsQueue(): Queue {
  if (!alertsQueue) {
    const connection = getRedisClient();
    alertsQueue = new Queue('alerts', {
      connection,
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
  }
  return alertsQueue;
}

export async function closeAlertsQueue(): Promise<void> {
  if (alertsQueue) {
    await alertsQueue.close();
    alertsQueue = null;
  }
}
