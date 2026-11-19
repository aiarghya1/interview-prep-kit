import { randomBytes } from 'node:crypto';
import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().nonnegative().default(4000), // 0 = any free port (tests)
  MONGODB_URI: z.string().default('mongodb://127.0.0.1:27017/interview-prep-kit'),
  JWT_SECRET: z.string().optional(),
  SESSION_TTL_HOURS: z.coerce.number().positive().default(24 * 7),
  JOB_TIMEOUT_MS: z.coerce.number().int().positive().default(6 * 60_000),
  MAX_ACTIVE_JOBS_PER_USER: z.coerce.number().int().positive().default(5),
});

export type Config = z.infer<typeof EnvSchema> & { JWT_SECRET: string; cookieSecure: boolean };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.parse(env);
  let secret = parsed.JWT_SECRET;
  if (!secret || secret.length < 32) {
    if (parsed.NODE_ENV === 'production') throw new Error('JWT_SECRET must be set (32+ characters) in production');
    secret = randomBytes(32).toString('hex');
    if (parsed.NODE_ENV !== 'test') console.warn('JWT_SECRET not set: using a random secret; sessions reset on restart');
  }
  return { ...parsed, JWT_SECRET: secret, cookieSecure: parsed.NODE_ENV === 'production' };
}
