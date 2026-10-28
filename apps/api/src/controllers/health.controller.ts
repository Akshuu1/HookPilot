import type { Request, Response, NextFunction } from 'express';
import { HealthService, healthService } from '../services/health.service.js';

export class HealthController {
  constructor(private readonly service: HealthService = healthService) {}

  getRoot = (_req: Request, res: Response): void => {
    res.status(200).json({
      name: 'HookPilot API',
      status: 'operational',
      version: '0.1.0',
      documentation: 'https://github.com/Akshuu1/HookPilot',
      endpoints: {
        health: '/health',
        ready: '/ready',
        metrics: '/metrics',
        auth: '/auth',
        workspaces: '/workspaces',
        endpoints: '/endpoints',
        events: '/events',
        ingest: '/in/:workspaceSlug/:endpointSlug',
      },
    });
  };

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
