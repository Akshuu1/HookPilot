import type { Request, Response, NextFunction } from 'express';
import { EventFilterQuerySchema, BulkReplayInputSchema } from '@hookpilot/shared';
import {
  type EventService,
  eventService as defaultEventService,
} from '../services/event.service.js';
import { AppError } from '../middlewares/error-handler.js';

export class EventController {
  constructor(private readonly service: EventService = defaultEventService) {}

  getEndpointEvents = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const endpointId = String(req.params.id);
      const queryValidation = EventFilterQuerySchema.safeParse(req.query);
      if (!queryValidation.success) {
        throw new AppError(
          `Invalid query parameters: ${queryValidation.error.message}`,
          400,
          'VALIDATION_ERROR',
        );
      }

      const result = await this.service.getEndpointEvents(endpointId, queryValidation.data);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  };

  getById = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const eventId = String(req.params.id);
      const result = await this.service.getEventWithAttempts(eventId);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  };

  replay = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const eventId = String(req.params.id);
      const userId = req.user!.id;
      const result = await this.service.replayEvent(eventId, userId);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  };

  bulkReplay = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const bodyValidation = BulkReplayInputSchema.safeParse(req.body);
      if (!bodyValidation.success) {
        throw new AppError(
          `Invalid request body: ${bodyValidation.error.message}`,
          400,
          'VALIDATION_ERROR',
        );
      }

      const userId = req.user!.id;
      const result = await this.service.bulkReplay(bodyValidation.data, userId);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  };

  delete = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const eventId = String(req.params.id);
      const userId = req.user!.id;
      await this.service.deleteEvent(eventId, userId);
      res.status(200).json({ success: true });
    } catch (err) {
      next(err);
    }
  };
}

export const eventController = new EventController();
