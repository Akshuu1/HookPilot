import { Types } from 'mongoose';
import type {
  AnalyticsRange,
  AnalyticsResponse,
  AnalyticsSummary,
  AnalyticsTimeseriesPoint,
  AnalyticsLatencyPercentiles,
  AnalyticsFailureReason,
} from '@hookpilot/shared';
import { EventModel } from '../models/Event.js';
import { DeliveryAttemptModel } from '../models/DeliveryAttempt.js';
import { getRedisClient } from '../config/redis.js';
import { logger } from '../config/logger.js';

export class AnalyticsService {
  async getAnalytics(
    workspaceId: string,
    range: AnalyticsRange = '24h',
    endpointId?: string,
  ): Promise<AnalyticsResponse> {
    const redis = getRedisClient();
    const cacheKey = `cache:analytics:${workspaceId}:${endpointId || 'all'}:${range}`;

    // 1. Check Redis cache (30s TTL)
    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached) as AnalyticsResponse;
        return { ...parsed, cached: true };
      }
    } catch (cacheErr) {
      logger.warn({ err: cacheErr }, 'Failed to read analytics from Redis cache');
    }

    // 2. Compute date range & aggregation bucket units
    const now = new Date();
    let fromDate: Date;
    let dateTruncUnit: 'minute' | 'hour' | 'day' = 'hour';

    switch (range) {
      case '1h':
        fromDate = new Date(now.getTime() - 60 * 60 * 1000);
        dateTruncUnit = 'minute';
        break;
      case '7d':
        fromDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        dateTruncUnit = 'day';
        break;
      case '24h':
      default:
        fromDate = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        dateTruncUnit = 'hour';
        break;
    }

    const wsObjectId = new Types.ObjectId(workspaceId);
    const eventMatchStage: Record<string, unknown> = {
      workspaceId: wsObjectId,
      receivedAt: { $gte: fromDate },
    };

    if (endpointId && Types.ObjectId.isValid(endpointId)) {
      eventMatchStage.endpointId = new Types.ObjectId(endpointId);
    }

    // Attempt match stage (lookup on event)
    const attemptMatchStage: Record<string, unknown> = {
      'event.workspaceId': wsObjectId,
      startedAt: { $gte: fromDate },
    };

    if (endpointId && Types.ObjectId.isValid(endpointId)) {
      attemptMatchStage['event.endpointId'] = new Types.ObjectId(endpointId);
    }

    // 3. Run aggregations in parallel
    const [summaryData, timeseriesData, latencyData, failuresData] = await Promise.all([
      this.computeSummary(eventMatchStage),
      this.computeTimeseries(eventMatchStage, dateTruncUnit),
      this.computeLatency(attemptMatchStage),
      this.computeTopFailures(attemptMatchStage),
    ]);

    const response: AnalyticsResponse = {
      range,
      summary: summaryData,
      timeseries: timeseriesData,
      latency: latencyData,
      topFailures: failuresData,
      cached: false,
    };

    // 4. Save in Redis with 30s TTL
    try {
      await redis.set(cacheKey, JSON.stringify(response), 'EX', 30);
    } catch (cacheErr) {
      logger.warn({ err: cacheErr }, 'Failed to write analytics to Redis cache');
    }

    return response;
  }

  private async computeSummary(matchStage: Record<string, unknown>): Promise<AnalyticsSummary> {
    const res = await EventModel.aggregate([
      { $match: matchStage },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          delivered: {
            $sum: { $cond: [{ $eq: ['$status', 'delivered'] }, 1, 0] },
          },
          failed: {
            $sum: { $cond: [{ $in: ['$status', ['failed', 'dead']] }, 1, 0] },
          },
          pending: {
            $sum: { $cond: [{ $in: ['$status', ['pending', 'delivering']] }, 1, 0] },
          },
        },
      },
    ]);

    if (!res || res.length === 0) {
      return {
        total: 0,
        delivered: 0,
        failed: 0,
        pending: 0,
        successRate: 100,
      };
    }

    const item = res[0] as { total: number; delivered: number; failed: number; pending: number };
    const successRate =
      item.total > 0 ? Math.round((item.delivered / item.total) * 1000) / 10 : 100;

    return {
      total: item.total,
      delivered: item.delivered,
      failed: item.failed,
      pending: item.pending,
      successRate,
    };
  }

  private async computeTimeseries(
    matchStage: Record<string, unknown>,
    unit: 'minute' | 'hour' | 'day',
  ): Promise<AnalyticsTimeseriesPoint[]> {
    const res = await EventModel.aggregate([
      { $match: matchStage },
      {
        $group: {
          _id: {
            $dateTrunc: {
              date: '$receivedAt',
              unit,
            },
          },
          total: { $sum: 1 },
          delivered: {
            $sum: { $cond: [{ $eq: ['$status', 'delivered'] }, 1, 0] },
          },
          failed: {
            $sum: { $cond: [{ $in: ['$status', ['failed', 'dead']] }, 1, 0] },
          },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    return res.map((r: { _id: Date; total: number; delivered: number; failed: number }) => ({
      timestamp: r._id ? new Date(r._id).toISOString() : new Date().toISOString(),
      total: r.total,
      delivered: r.delivered,
      failed: r.failed,
    }));
  }

  private async computeLatency(
    attemptMatchStage: Record<string, unknown>,
  ): Promise<AnalyticsLatencyPercentiles> {
    const res = await DeliveryAttemptModel.aggregate([
      {
        $lookup: {
          from: 'events',
          localField: 'eventId',
          foreignField: '_id',
          as: 'event',
        },
      },
      { $unwind: '$event' },
      { $match: attemptMatchStage },
      {
        $group: {
          _id: null,
          durations: { $push: '$durationMs' },
        },
      },
    ]);

    if (!res || res.length === 0 || !res[0]?.durations?.length) {
      return { p50: 0, p95: 0, p99: 0 };
    }

    const durations = (res[0].durations as number[]).sort((a, b) => a - b);
    const getPercentile = (p: number): number => {
      const idx = Math.min(Math.floor(durations.length * p), durations.length - 1);
      return durations[idx] ?? 0;
    };

    return {
      p50: getPercentile(0.5),
      p95: getPercentile(0.95),
      p99: getPercentile(0.99),
    };
  }

  private async computeTopFailures(
    attemptMatchStage: Record<string, unknown>,
  ): Promise<AnalyticsFailureReason[]> {
    const res = await DeliveryAttemptModel.aggregate([
      {
        $lookup: {
          from: 'events',
          localField: 'eventId',
          foreignField: '_id',
          as: 'event',
        },
      },
      { $unwind: '$event' },
      {
        $match: {
          ...attemptMatchStage,
          success: false,
        },
      },
      {
        $group: {
          _id: {
            $ifNull: ['$error', { $concat: ['HTTP ', { $toString: '$responseStatus' }] }],
          },
          count: { $sum: 1 },
        },
      },
      { $sort: { count: -1 } },
      { $limit: 5 },
    ]);

    return res.map((r: { _id: string; count: number }) => ({
      reason: r._id || 'Unknown Error',
      count: r.count,
    }));
  }
}

export const analyticsService = new AnalyticsService();
