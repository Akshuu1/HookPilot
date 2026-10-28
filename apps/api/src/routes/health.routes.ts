import { Router } from 'express';
import { healthController } from '../controllers/health.controller.js';

export const healthRouter = Router();

healthRouter.get('/health', healthController.getHealth);
healthRouter.get('/ready', healthController.getReady);
