import type { Request, Response, NextFunction } from 'express';
import { checkEndpointRateLimit } from '../middlewares/ingest-rate-limiter.js';
import {
  IngestService,
  ingestService as defaultIngestService,
} from '../services/ingest.service.js';
import { ingestRequestsTotal, ingestDurationSeconds } from '../config/metrics.js';
import { logger } from '../config/logger.js';

export class IngestController {
  constructor(private readonly service: IngestService = defaultIngestService) {}

  ingest = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const startTime = process.hrtime();
    const slug = String(req.params.slug);

    try {
      const rawBody = req.rawBody || '';
      const rawBodyBuffer = req.rawBodyBuffer || Buffer.from(rawBody, 'utf8');

      // Pre-resolve endpoint to apply rate limiting
      const endpoint = await this.service.resolveEndpoint(slug);

      const isAllowed = await checkEndpointRateLimit(endpoint.id, endpoint.rateLimitPerMin, res);
      if (!isAllowed) {
        ingestRequestsTotal.inc({ endpoint: slug, status: '429' });
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

      const [seconds, nanoseconds] = process.hrtime(startTime);
      const duration = seconds + nanoseconds / 1e9;
      ingestRequestsTotal.inc({ endpoint: slug, status: '202' });
      ingestDurationSeconds.observe({ endpoint: slug }, duration);

      logger.info(
        {
          requestId: req.id,
          eventId: result.eventId,
          slug,
          durationMs: Math.round(duration * 1000),
        },
        'Webhook ingested successfully',
      );

      // 202 Accepted response with eventId
      res.status(202).json({
        eventId: result.eventId,
      });
    } catch (err) {
      const [seconds, nanoseconds] = process.hrtime(startTime);
      const duration = seconds + nanoseconds / 1e9;
      const status = (err as { statusCode?: number })?.statusCode || 500;
      ingestRequestsTotal.inc({ endpoint: slug || 'unknown', status: status.toString() });
      ingestDurationSeconds.observe({ endpoint: slug || 'unknown' }, duration);

      next(err);
    }
  };
}

export const ingestController = new IngestController();
