import { Router } from 'express';
import { authMiddleware } from '../middlewares/auth.middleware.js';
import { requireRole } from '../middlewares/role.middleware.js';
import { requireChannelRole } from '../middlewares/alert-role.middleware.js';
import { alertChannelController } from '../controllers/alert-channel.controller.js';

export const alertChannelRouter = Router();

// Workspace-scoped routes
alertChannelRouter.post(
  '/workspaces/:workspaceId/alert-channels',
  authMiddleware,
  requireRole('admin'),
  alertChannelController.create,
);

alertChannelRouter.get(
  '/workspaces/:workspaceId/alert-channels',
  authMiddleware,
  requireRole('viewer'),
  alertChannelController.list,
);

// Individual channel routes
alertChannelRouter.get(
  '/alert-channels/:id',
  authMiddleware,
  requireChannelRole('viewer'),
  alertChannelController.get,
);

alertChannelRouter.patch(
  '/alert-channels/:id',
  authMiddleware,
  requireChannelRole('admin'),
  alertChannelController.update,
);

alertChannelRouter.delete(
  '/alert-channels/:id',
  authMiddleware,
  requireChannelRole('admin'),
  alertChannelController.delete,
);

alertChannelRouter.post(
  '/alert-channels/:id/test',
  authMiddleware,
  requireChannelRole('admin'),
  alertChannelController.test,
);
