import type { Request, Response, NextFunction } from 'express';
import { HealthService, healthService } from '../services/health.service.js';

export class HealthController {
  constructor(private readonly service: HealthService = healthService) {}

  getHealth = (_req: Request, res: Response, next: NextFunction): void => {
    try {
      const result = this.service.getLiveness();
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  };

  getReady = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { statusCode, data } = await this.service.getReadiness();
      res.status(statusCode).json(data);
    } catch (err) {
      next(err);
    }
  };
}

export const healthController = new HealthController();
