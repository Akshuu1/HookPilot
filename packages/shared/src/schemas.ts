import { z } from 'zod';

export const HealthStatusSchema = z.object({
  status: z.enum(['ok', 'error']),
  timestamp: z.string().datetime(),
  uptime: z.number().nonnegative(),
});

export type HealthStatus = z.infer<typeof HealthStatusSchema>;

export const ComponentHealthSchema = z.object({
  status: z.enum(['up', 'down']),
  latencyMs: z.number().nonnegative().optional(),
  error: z.string().optional(),
});

export const ReadyStatusSchema = z.object({
  status: z.enum(['ready', 'not_ready']),
  timestamp: z.string().datetime(),
  components: z.object({
    mongodb: ComponentHealthSchema,
    redis: ComponentHealthSchema,
  }),
});

export type ReadyStatus = z.infer<typeof ReadyStatusSchema>;

export const SampleEventPayloadSchema = z.object({
  id: z.string(),
  slug: z.string().min(1),
  rawBody: z.string(),
  headers: z.record(z.string()),
  receivedAt: z.string().datetime(),
});

export type SampleEventPayload = z.infer<typeof SampleEventPayloadSchema>;
