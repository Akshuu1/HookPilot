import { Job } from 'bullmq';
import { Types } from 'mongoose';
import { logger } from '../config/logger.js';
import { AlertHistoryModel } from '../models/AlertHistory.js';
import {
  alertTransportService,
  type AlertMessagePayload,
} from '../services/alert-transport.service.js';

export interface AlertJobData {
  historyId?: string;
  payload: AlertMessagePayload;
}

export async function alertNotificationProcessor(job: Job<AlertJobData>): Promise<void> {
  const { historyId, payload } = job.data;
  logger.info(
    { jobId: job.id, channelId: payload.channelId, kind: payload.kind },
    'Processing alert notification job',
  );

  const result = await alertTransportService.send(payload);

  if (historyId) {
    try {
      const history = await AlertHistoryModel.findById(historyId);
      if (history) {
        history.notifications.push({
          channelId: new Types.ObjectId(payload.channelId),
          kind: result.kind,
          status: result.status,
          error: result.error || null,
          sentAt: result.sentAt,
        });
        await history.save();
      }
    } catch (err: unknown) {
      logger.error({ historyId, err }, 'Failed to record alert notification in AlertHistory');
    }
  }

  if (result.status === 'failed') {
    // BullMQ retry with exponential backoff up to 5 attempts
    throw new Error(result.error || 'Alert notification failed to send');
  }
}
