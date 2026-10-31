import type { Request, Response, NextFunction } from 'express';
import { createAlertChannelSchema, updateAlertChannelSchema } from '@hookpilot/shared';
import { alertChannelService, mapAlertChannelResponse } from '../services/alert-channel.service.js';

export class AlertChannelController {
  async create(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const workspaceId = String(req.params.workspaceId);
      const validated = createAlertChannelSchema.parse(req.body);
      const channel = await alertChannelService.createChannel(
        workspaceId,
        req.user!.id,
        validated as { type: 'email' | 'slack'; name: string; config: Record<string, unknown> },
      );
      res.status(201).json(channel);
    } catch (err) {
      next(err);
    }
  }

  async list(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const workspaceId = String(req.params.workspaceId);
      const channels = await alertChannelService.listChannels(workspaceId);
      res.status(200).json({ channels });
    } catch (err) {
      next(err);
    }
  }

  async get(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const channel = req.alertChannel!;
      res.status(200).json(mapAlertChannelResponse(channel));
    } catch (err) {
      next(err);
    }
  }

  async update(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const channel = req.alertChannel!;
      const validated = updateAlertChannelSchema.parse(req.body);
      const updated = await alertChannelService.updateChannel(
        channel.id,
        channel.workspaceId.toString(),
        validated,
      );
      res.status(200).json(updated);
    } catch (err) {
      next(err);
    }
  }

  async delete(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const channel = req.alertChannel!;
      await alertChannelService.deleteChannel(channel.id, channel.workspaceId.toString());
      res.status(200).json({ success: true, message: 'Alert channel deleted' });
    } catch (err) {
      next(err);
    }
  }

  async test(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const channel = req.alertChannel!;
      const result = await alertChannelService.testChannel(
        channel.id,
        channel.workspaceId.toString(),
      );
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  }
}

export const alertChannelController = new AlertChannelController();
