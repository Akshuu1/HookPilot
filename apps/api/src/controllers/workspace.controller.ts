import type { Request, Response, NextFunction } from 'express';
import {
  CreateWorkspaceInputSchema,
  AddMemberInputSchema,
  ChangeRoleInputSchema,
} from '@hookpilot/shared';
import {
  WorkspaceService,
  workspaceService as defaultWorkspaceService,
} from '../services/workspace.service.js';

export class WorkspaceController {
  constructor(private readonly service: WorkspaceService = defaultWorkspaceService) {}

  create = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const input = CreateWorkspaceInputSchema.parse(req.body);
      const workspace = await this.service.createWorkspace(req.user!.id, input.name);
      res.status(201).json({ workspace });
    } catch (err) {
      next(err);
    }
  };

  listMine = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const workspaces = await this.service.listUserWorkspaces(req.user!.id);
      res.status(200).json({ workspaces });
    } catch (err) {
      next(err);
    }
  };

  addMember = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const workspaceId = String(req.params.id);
      const input = AddMemberInputSchema.parse(req.body);
      const member = await this.service.addMember(workspaceId, input.email, input.role);
      res.status(201).json({ member });
    } catch (err) {
      next(err);
    }
  };

  changeMemberRole = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const workspaceId = String(req.params.id);
      const targetUserId = String(req.params.userId);
      const input = ChangeRoleInputSchema.parse(req.body);

      const member = await this.service.changeMemberRole(
        workspaceId,
        req.user!.id,
        targetUserId,
        input.role,
      );
      res.status(200).json({ member });
    } catch (err) {
      next(err);
    }
  };

  removeMember = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const workspaceId = String(req.params.id);
      const targetUserId = String(req.params.userId);

      await this.service.removeMember(workspaceId, req.user!.id, targetUserId);
      res.status(200).json({ message: 'Member removed successfully' });
    } catch (err) {
      next(err);
    }
  };
}

export const workspaceController = new WorkspaceController();
