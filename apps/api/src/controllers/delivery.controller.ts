import type { Request, Response, NextFunction } from 'express';
import { deliveryService } from '../services/delivery.service.js';

export class DeliveryController {
  async replay(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const deliveryId = String(req.params.id);
      const userId = req.user?.id || 'system';
      const force = Boolean(req.body?.force);
      const result = await deliveryService.replayDelivery(deliveryId, userId, force);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  }

  async forceDeliver(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const deliveryId = String(req.params.id);
      const userId = req.user?.id || 'system';
      const result = await deliveryService.forceDeliver(deliveryId, userId);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  }

  async get(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const deliveryId = String(req.params.id);
      const delivery = await deliveryService.getDeliveryById(deliveryId);
      const mapped = await deliveryService.mapDeliveryResponse(delivery);
      res.status(200).json(mapped);
    } catch (err) {
      next(err);
    }
  }
}

export const deliveryController = new DeliveryController();
