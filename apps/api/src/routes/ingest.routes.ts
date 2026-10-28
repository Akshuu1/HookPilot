import { Router } from 'express';
import { ingestController } from '../controllers/ingest.controller.js';
import { rawBodyCapture } from '../middlewares/raw-body.middleware.js';

export const ingestRouter = Router();

// Ingest routes capture the raw buffer before any JSON parsing
ingestRouter.use(rawBodyCapture);

ingestRouter.post('/:slug', ingestController.ingest);
ingestRouter.put('/:slug', ingestController.ingest);
ingestRouter.patch('/:slug', ingestController.ingest);
