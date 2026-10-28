import { Router } from 'express';
import { eventController } from '../controllers/event.controller.js';
import { authMiddleware } from '../middlewares/auth.middleware.js';
import {
  requireEventRole,
  requireBodyWorkspaceRole,
} from '../middlewares/event-role.middleware.js';

export const eventRouter = Router();

eventRouter.use(authMiddleware);

// Bulk Replay (requires member role on target workspace)
eventRouter.post('/bulk-replay', requireBodyWorkspaceRole('member'), eventController.bulkReplay);

// Event detail with attempts (requires viewer role)
eventRouter.get('/:id', requireEventRole('viewer'), eventController.getById);

// Single Replay (requires member role)
eventRouter.post('/:id/replay', requireEventRole('member'), eventController.replay);

// Delete Event (requires admin role)
eventRouter.delete('/:id', requireEventRole('admin'), eventController.delete);
