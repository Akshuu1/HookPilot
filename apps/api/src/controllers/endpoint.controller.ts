import type { Request, Response, NextFunction } from 'express';
import {
  CreateEndpointInputSchema,
  UpdateEndpointInputSchema,
  RotateSecretInputSchema,
} from '@hookpilot/shared';
import {
  EndpointService,
  endpointService as defaultEndpointService,
} from '../services/endpoint.service.js';

export class EndpointController {
  constructor(private readonly service: EndpointService = defaultEndpointService) {}

  create = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const workspaceId = String(req.params.workspaceId || req.params.id);
      const input = CreateEndpointInputSchema.parse(req.body);
      const endpoint = await this.service.createEndpoint(workspaceId, input);
      res.status(201).json({ endpoint });
    } catch (err) {
      next(err);
    }
  };

  list = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const workspaceId = String(req.params.workspaceId || req.params.id);
      const endpoints = await this.service.listWorkspaceEndpoints(workspaceId);
      res.status(200).json({ endpoints });
    } catch (err) {
      next(err);
    }
  };

  getById = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const id = String(req.params.id);
      const endpoint = await this.service.getEndpoint(id);
      res.status(200).json({ endpoint });
    } catch (err) {
      next(err);
    }
  };

  update = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const id = String(req.params.id);
      const input = UpdateEndpointInputSchema.parse(req.body);
      const endpoint = await this.service.updateEndpoint(id, input);
      res.status(200).json({ endpoint });
    } catch (err) {
      next(err);
    }
  };

  delete = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const id = String(req.params.id);
      await this.service.deleteEndpoint(id);
      res.status(200).json({ message: 'Endpoint deleted successfully' });
    } catch (err) {
      next(err);
    }
  };

  rotateSecret = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const id = String(req.params.id);
      const input = RotateSecretInputSchema.parse(req.body);
      const result = await this.service.rotateSecret(id, input.secret);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  };
}

export const endpointController = new EndpointController();
