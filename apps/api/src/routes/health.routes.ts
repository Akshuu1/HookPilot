import { Router } from 'express';
import { healthController } from '../controllers/health.controller.js';
import { registry, updateGauges } from '../config/metrics.js';

export const healthRouter = Router();

healthRouter.get('/health', healthController.getHealth);
healthRouter.get('/ready', healthController.getReady);

healthRouter.get('/metrics', async (_req, res) => {
  await updateGauges();
  res.set('Content-Type', registry.contentType);
  res.end(await registry.metrics());
});
