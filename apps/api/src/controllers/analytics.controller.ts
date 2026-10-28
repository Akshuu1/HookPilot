import type { Request, Response, NextFunction } from 'express';
import { AnalyticsQuerySchema } from '@hookpilot/shared';
import {
  AnalyticsService,
  analyticsService as defaultAnalyticsService,
} from '../services/analytics.service.js';
import { AppError } from '../middlewares/error-handler.js';

export class AnalyticsController {
  constructor(private readonly service: AnalyticsService = defaultAnalyticsService) {}

  getAnalytics = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const workspaceId =
        req.workspaceId || (typeof req.params.id === 'string' ? req.params.id : undefined);

      if (!workspaceId) {
        throw new AppError('Workspace context missing', 400, 'WORKSPACE_MISSING');
      }

      const query = AnalyticsQuerySchema.parse(req.query);
      const data = await this.service.getAnalytics(workspaceId, query.range, query.endpointId);

      res.status(200).json(data);
    } catch (err) {
      next(err);
    }
  };
}

export const analyticsController = new AnalyticsController();
