import { Router } from 'express';
import { endpointController } from '../controllers/endpoint.controller.js';
import { eventController } from '../controllers/event.controller.js';
import { authMiddleware } from '../middlewares/auth.middleware.js';
import { requireEndpointRole } from '../middlewares/endpoint-role.middleware.js';

export const endpointRouter = Router();

endpointRouter.use(authMiddleware);

// Endpoints by ID
endpointRouter.get('/:id', requireEndpointRole('viewer'), endpointController.getById);
endpointRouter.get('/:id/events', requireEndpointRole('viewer'), eventController.getEndpointEvents);
endpointRouter.patch('/:id', requireEndpointRole('member'), endpointController.update);
endpointRouter.delete('/:id', requireEndpointRole('member'), endpointController.delete);
endpointRouter.post(
  '/:id/rotate-secret',
  requireEndpointRole('member'),
  endpointController.rotateSecret,
);
