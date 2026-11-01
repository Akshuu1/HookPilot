import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

// Support JWT_SECRET as fallback alias for JWT_ACCESS_SECRET
if (!process.env.JWT_ACCESS_SECRET && process.env.JWT_SECRET) {
  process.env.JWT_ACCESS_SECRET = process.env.JWT_SECRET;
}

export function validateCoreEnv(
  envMap: Record<string, string | undefined> = process.env,
): string[] {
  const missingCoreVars: string[] = [];
  if (!envMap.MONGODB_URI) {
    missingCoreVars.push('MONGODB_URI');
  }
  if (!envMap.REDIS_URL) {
    missingCoreVars.push('REDIS_URL');
  }
  if (!envMap.JWT_ACCESS_SECRET && !envMap.JWT_SECRET) {
    missingCoreVars.push('JWT_ACCESS_SECRET');
  }
  if (!envMap.ENCRYPTION_KEY) {
    missingCoreVars.push('ENCRYPTION_KEY');
  }
  return missingCoreVars;
}

// In production, strictly require core environment variables (without printing secret values)
if (process.env.NODE_ENV === 'production') {
  const missing = validateCoreEnv(process.env);
  if (missing.length > 0) {
    throw new Error(
      `Missing required core environment variable(s): ${missing.join(', ')}. Server cannot start in production without these variables.`,
    );
  }
}

const envSchema = z.object({
  PORT: z.coerce.number().default(4000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  MONGODB_URI: z.string().default('mongodb://localhost:27017/hookpilot'),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),

  // Auth & Security
  JWT_ACCESS_SECRET: z.string().default('hookpilot-dev-jwt-access-secret-32-chars-min!'),
  JWT_REFRESH_SECRET: z.string().default('hookpilot-dev-jwt-refresh-secret-32-chars-min!'),
  JWT_ACCESS_EXPIRES_IN: z.string().default('15m'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('7d'),
  COOKIE_SECRET: z.string().default('hookpilot-dev-cookie-secret-key-32-chars!'),
  COOKIE_SAME_SITE: z.enum(['lax', 'strict', 'none']).optional(),
  ENCRYPTION_KEY: z
    .string()
    .default('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'),

  // SMTP & Alerts (Feature-specific: optional)
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().default(1025),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  ALERT_FROM: z.string().default('alerts@hookpilot.dev'),
  DASHBOARD_URL: z.string().default('http://localhost:5173'),
  SLACK_WEBHOOK_URL: z.string().optional(),

  // Phase 19: OAuth Providers & URLs (Feature-specific: optional)
  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  API_PUBLIC_URL: z.string().default('http://localhost:4000'),
  FRONTEND_URL: z.string().default('http://localhost:5173'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const missingFields = Object.keys(parsed.error.flatten().fieldErrors).join(', ');
  console.error(`Invalid environment variables in API: ${missingFields}`);
  throw new Error(`Invalid environment variables: ${missingFields}`);
}

export const env = parsed.data;
export type Env = z.infer<typeof envSchema>;

export function logFeatureStatus(logger: { info: (msg: string) => void }): void {
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
    logger.info('GitHub login is disabled (missing GITHUB_CLIENT_ID or GITHUB_CLIENT_SECRET)');
  }
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    logger.info('Google login is disabled (missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET)');
  }
  if (!env.SMTP_HOST) {
    logger.info('Email alerts are disabled (missing SMTP_HOST)');
  }
  if (!env.SLACK_WEBHOOK_URL) {
    logger.info('Slack alerts are disabled (missing SLACK_WEBHOOK_URL)');
  }
}
