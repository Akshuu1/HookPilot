import { Router } from 'express';
import { authMiddleware } from '../middlewares/auth.middleware.js';
import { requireDestinationRole } from '../middlewares/destination-role.middleware.js';
import { destinationController } from '../controllers/destination.controller.js';

export const destinationRouter = Router();

destinationRouter.use(authMiddleware);

destinationRouter.get('/:id', requireDestinationRole('viewer'), (req, res, next) =>
  destinationController.get(req, res, next),
);

destinationRouter.patch('/:id', requireDestinationRole('member'), (req, res, next) =>
  destinationController.update(req, res, next),
);

destinationRouter.post('/:id/test-filter', requireDestinationRole('member'), (req, res, next) =>
  destinationController.testFilter(req, res, next),
);

destinationRouter.post('/:id/filter-preview', requireDestinationRole('member'), (req, res, next) =>
  destinationController.previewFilter(req, res, next),
);

destinationRouter.delete('/:id', requireDestinationRole('admin'), (req, res, next) =>
  destinationController.delete(req, res, next),
);
