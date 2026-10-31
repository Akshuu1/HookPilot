import { Router } from 'express';
import { authMiddleware } from '../middlewares/auth.middleware.js';
import { requireRole } from '../middlewares/role.middleware.js';
import { requireRuleRole } from '../middlewares/alert-role.middleware.js';
import { alertRuleController } from '../controllers/alert-rule.controller.js';

export const alertRuleRouter = Router();

// Workspace-scoped routes
alertRuleRouter.post(
  '/workspaces/:workspaceId/alert-rules',
  authMiddleware,
  requireRole('admin'),
  alertRuleController.create,
);

alertRuleRouter.get(
  '/workspaces/:workspaceId/alert-rules',
  authMiddleware,
  requireRole('viewer'),
  alertRuleController.list,
);

// Individual rule routes
alertRuleRouter.get(
  '/alert-rules/:id',
  authMiddleware,
  requireRuleRole('viewer'),
  alertRuleController.get,
);

alertRuleRouter.patch(
  '/alert-rules/:id',
  authMiddleware,
  requireRuleRole('admin'),
  alertRuleController.update,
);

alertRuleRouter.delete(
  '/alert-rules/:id',
  authMiddleware,
  requireRuleRole('admin'),
  alertRuleController.delete,
);

alertRuleRouter.get(
  '/alert-rules/:id/history',
  authMiddleware,
  requireRuleRole('viewer'),
  alertRuleController.getHistory,
);

alertRuleRouter.post(
  '/alert-rules/:id/test-evaluate',
  authMiddleware,
  requireRuleRole('viewer'),
  alertRuleController.testEvaluate,
);
