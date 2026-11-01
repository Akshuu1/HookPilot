import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

export function validateWorkerCoreEnv(
  envMap: Record<string, string | undefined> = process.env,
): string[] {
  const missingCoreVars: string[] = [];
  if (!envMap.MONGODB_URI) {
    missingCoreVars.push('MONGODB_URI');
  }
  if (!envMap.REDIS_URL) {
    missingCoreVars.push('REDIS_URL');
  }
  if (!envMap.ENCRYPTION_KEY) {
    missingCoreVars.push('ENCRYPTION_KEY');
  }
  return missingCoreVars;
}

// In production, strictly require core environment variables (without printing secret values)
if (process.env.NODE_ENV === 'production') {
  const missing = validateWorkerCoreEnv(process.env);
  if (missing.length > 0) {
    throw new Error(
      `Missing required core environment variable(s) in worker: ${missing.join(', ')}. Worker cannot start in production without these variables.`,
    );
  }
}

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  MONGODB_URI: z.string().default('mongodb://localhost:27017/hookpilot'),
  ENCRYPTION_KEY: z
    .string()
    .default('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'),
  CONCURRENCY: z.coerce.number().default(Number(process.env.WORKER_CONCURRENCY) || 10),

  // SMTP & Alerts (Feature-specific: optional)
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().default(1025),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  ALERT_FROM: z.string().default('alerts@hookpilot.dev'),
  DASHBOARD_URL: z.string().default('http://localhost:5173'),
  SLACK_WEBHOOK_URL: z.string().optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const missingFields = Object.keys(parsed.error.flatten().fieldErrors).join(', ');
  console.error(`Invalid worker environment: ${missingFields}`);
  throw new Error(`Invalid worker environment: ${missingFields}`);
}

export const env = parsed.data;
export type WorkerEnv = z.infer<typeof envSchema>;

export function logWorkerFeatureStatus(logger: { info: (msg: string) => void }): void {
  if (!env.SMTP_HOST) {
    logger.info('Email alerts are disabled (missing SMTP_HOST)');
  }
  if (!env.SLACK_WEBHOOK_URL) {
    logger.info('Slack alerts are disabled (missing SLACK_WEBHOOK_URL)');
  }
}
