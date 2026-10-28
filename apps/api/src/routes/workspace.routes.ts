import { Router } from 'express';
import { workspaceController } from '../controllers/workspace.controller.js';
import { endpointController } from '../controllers/endpoint.controller.js';
import { apiKeyController } from '../controllers/api-key.controller.js';
import { analyticsController } from '../controllers/analytics.controller.js';
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

// API Keys scoped to workspace:
// - Admin or above can create and revoke
// - Member or above can list
workspaceRouter.post('/:id/api-keys', requireRole('admin'), apiKeyController.create);
workspaceRouter.get('/:id/api-keys', requireRole('member'), apiKeyController.list);
workspaceRouter.delete('/:id/api-keys/:keyId', requireRole('admin'), apiKeyController.revoke);

// Analytics scoped to workspace:
workspaceRouter.get('/:id/analytics', requireRole('viewer'), analyticsController.getAnalytics);
