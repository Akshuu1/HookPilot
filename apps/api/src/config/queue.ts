import { Queue } from 'bullmq';
import { getRedisClient } from './redis.js';

let deliveryQueue: Queue | null = null;

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
