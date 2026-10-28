import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  MONGODB_URI: z.string().default('mongodb://localhost:27017/hookpilot'),
  ENCRYPTION_KEY: z
    .string()
    .default('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'),
  CONCURRENCY: z.coerce.number().default(10),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid worker environment:', JSON.stringify(parsed.error.format(), null, 2));
  process.exit(1);
}

export const env = parsed.data;
export type WorkerEnv = z.infer<typeof envSchema>;
