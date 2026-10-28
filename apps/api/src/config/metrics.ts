import client from 'prom-client';
import { getDeliveryQueue } from './queue.js';
import { EventModel } from '../models/Event.js';
import { logger } from './logger.js';

// Create a custom registry
export const registry = new client.Registry();

// Enable standard default metrics (process CPU, memory, event loop, etc.)
client.collectDefaultMetrics({ register: registry, prefix: 'hookpilot_' });

// Ingest requests total counter
export const ingestRequestsTotal = new client.Counter({
  name: 'ingest_requests_total',
  help: 'Total count of inbound webhook requests ingested',
  labelNames: ['endpoint', 'status'],
  registers: [registry],
});

// Ingest duration seconds histogram
export const ingestDurationSeconds = new client.Histogram({
  name: 'ingest_duration_seconds',
  help: 'Latency of webhook ingest processing in seconds',
  labelNames: ['endpoint'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

// Delivery attempts total counter
export const deliveryAttemptsTotal = new client.Counter({
  name: 'delivery_attempts_total',
  help: 'Total count of webhook delivery attempts executed by the worker',
  labelNames: ['endpoint', 'result'],
  registers: [registry],
});

// Queue depth gauge
export const queueDepthGauge = new client.Gauge({
  name: 'queue_depth',
  help: 'Number of active and waiting delivery jobs in the queue',
  registers: [registry],
});

// Dead letter queue size gauge
export const dlqSizeGauge = new client.Gauge({
  name: 'dlq_size',
  help: 'Total number of events in dead state',
  registers: [registry],
});

/**
 * Updates dynamic gauges (queue depth & DLQ size) prior to Prometheus scraping.
 */
export async function updateGauges(): Promise<void> {
  try {
    const queue = getDeliveryQueue();
    const [waiting, active] = await Promise.all([
      queue.getWaitingCount().catch(() => 0),
      queue.getActiveCount().catch(() => 0),
    ]);
    queueDepthGauge.set(waiting + active);
  } catch (err) {
    logger.warn({ err }, 'Failed to collect queue depth metric');
  }

  try {
    const deadCount = await EventModel.countDocuments({ status: 'dead' }).catch(() => 0);
    dlqSizeGauge.set(deadCount);
  } catch (err) {
    logger.warn({ err }, 'Failed to collect DLQ size metric');
  }
}
