import type { Request, Response, NextFunction } from 'express';
import { checkEndpointRateLimit } from '../middlewares/ingest-rate-limiter.js';
import {
  IngestService,
  ingestService as defaultIngestService,
} from '../services/ingest.service.js';

export class IngestController {
  constructor(private readonly service: IngestService = defaultIngestService) {}

  ingest = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const slug = String(req.params.slug);
      const rawBody = req.rawBody || '';
      const rawBodyBuffer = req.rawBodyBuffer || Buffer.from(rawBody, 'utf8');

      // Pre-resolve endpoint to apply rate limiting
      const endpoint = await this.service.resolveEndpoint(slug);

      const isAllowed = await checkEndpointRateLimit(endpoint.id, endpoint.rateLimitPerMin, res);
      if (!isAllowed) {
        return;
      }

      const sourceIp =
        (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
        req.socket.remoteAddress ||
        'unknown';

      const contentType = (req.headers['content-type'] as string) || null;

      const result = await this.service.handleIngest({
        slug,
        method: req.method,
        headers: req.headers,
        rawBody,
        bodySize: rawBodyBuffer.length,
        contentType,
        sourceIp,
      });

      // 202 Accepted response with eventId
      res.status(202).json({
        eventId: result.eventId,
      });
    } catch (err) {
      next(err);
    }
  };
}

export const ingestController = new IngestController();
