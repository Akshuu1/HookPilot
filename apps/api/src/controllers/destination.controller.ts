import type { Request, Response, NextFunction } from 'express';
import { CreateDestinationInputSchema, UpdateDestinationInputSchema } from '@hookpilot/shared';
import { destinationService } from '../services/destination.service.js';

export class DestinationController {
  async create(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const endpointId = String(req.params.id);
      const validated = CreateDestinationInputSchema.parse(req.body);
      const destination = await destinationService.createDestination(endpointId, validated);
      res.status(201).json(destination);
    } catch (err) {
      next(err);
    }
  }

  async list(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const endpointId = String(req.params.id);
      const destinations = await destinationService.listDestinations(endpointId);
      res.status(200).json({ data: destinations });
    } catch (err) {
      next(err);
    }
  }

  async get(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = String(req.params.id);
      const destination = await destinationService.getDestination(id);
      res.status(200).json(destination);
    } catch (err) {
      next(err);
    }
  }

  async update(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = String(req.params.id);
      const validated = UpdateDestinationInputSchema.parse(req.body);
      const destination = await destinationService.updateDestination(id, validated);
      res.status(200).json(destination);
    } catch (err) {
      next(err);
    }
  }

  async delete(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = String(req.params.id);
      await destinationService.deleteDestination(id);
      res.status(200).json({ success: true, message: 'Destination deleted' });
    } catch (err) {
      next(err);
    }
  }
}

export const destinationController = new DestinationController();
