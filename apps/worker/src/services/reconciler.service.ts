import { DeliveryModel } from '../models/Delivery.js';
import { getDeliveryQueue } from '../config/redis.js';
import { logger } from '../config/logger.js';

export class ReconcilerService {
  async reconcile(): Promise<{ enqueuedCount: number }> {
    const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000);

    const orphanedDeliveries = await DeliveryModel.find({
      status: 'pending',
      createdAt: { $lte: twoMinutesAgo },
    });

    let enqueuedCount = 0;
    const queue = getDeliveryQueue();

    for (const delivery of orphanedDeliveries) {
      const deliveryId = delivery._id.toString();

      try {
        const existingJob = await queue.getJob(deliveryId);
        if (existingJob) {
          const state = await existingJob.getState();
          if (state === 'active' || state === 'waiting' || state === 'delayed') {
            continue; // Job already active or waiting in queue
          }
        }

        await queue.add(
          'deliver',
          { deliveryId },
          {
            jobId: deliveryId, // No colons!
            attempts: 1,
            removeOnComplete: true,
          },
        );
        enqueuedCount++;
      } catch (err) {
        logger.error({ err, deliveryId }, 'Failed to reconcile orphaned delivery');
      }
    }

    return { enqueuedCount };
  }
}

export const reconcilerService = new ReconcilerService();
