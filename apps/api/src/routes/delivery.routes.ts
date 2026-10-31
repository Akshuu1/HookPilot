import { Router } from 'express';
import { authMiddleware } from '../middlewares/auth.middleware.js';
import { requireDeliveryRole } from '../middlewares/delivery-role.middleware.js';
import { deliveryController } from '../controllers/delivery.controller.js';

export const deliveryRouter = Router();

deliveryRouter.use(authMiddleware);

deliveryRouter.get('/:id', requireDeliveryRole('viewer'), (req, res, next) =>
  deliveryController.get(req, res, next),
);

deliveryRouter.post('/:id/replay', requireDeliveryRole('member'), (req, res, next) =>
  deliveryController.replay(req, res, next),
);
