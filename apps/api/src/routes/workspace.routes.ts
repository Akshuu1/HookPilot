import { Router } from 'express';
import { workspaceController } from '../controllers/workspace.controller.js';
import { endpointController } from '../controllers/endpoint.controller.js';
import { authMiddleware } from '../middlewares/auth.middleware.js';
import { requireRole } from '../middlewares/role.middleware.js';

export const workspaceRouter = Router();

// All workspace routes require authentication
workspaceRouter.use(authMiddleware);

workspaceRouter.post('/', workspaceController.create);
workspaceRouter.get('/', workspaceController.listMine);

// Member management routes require at least 'admin' role
workspaceRouter.post('/:id/members', requireRole('admin'), workspaceController.addMember);
workspaceRouter.patch(
  '/:id/members/:userId',
  requireRole('admin'),
  workspaceController.changeMemberRole,
);
workspaceRouter.delete(
  '/:id/members/:userId',
  requireRole('admin'),
  workspaceController.removeMember,
);

// Endpoints scoped to workspace:
// - Member or above can create
// - Viewer or above can list
workspaceRouter.post('/:id/endpoints', requireRole('member'), endpointController.create);
workspaceRouter.get('/:id/endpoints', requireRole('viewer'), endpointController.list);
