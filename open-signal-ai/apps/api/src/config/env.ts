import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const base64Key32 = z.string().refine((v) => Buffer.from(v, 'base64').length === 32, {
  message: 'must be 32 random bytes encoded as base64 (see docs/setup-from-scratch.md)',
});

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(8080),
    HOST: z.string().default('0.0.0.0'),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

    STORAGE_DRIVER: z.enum(['local', 'firestore']).default('local'),
    LOCAL_DATA_FILE: z.string().default('.data/local-store.json'),

    ENCRYPTION_KEY: base64Key32,
    ENCRYPTION_KEY_ID: z.string().regex(/^[a-z0-9]{1,16}$/i).default('k1'),
    /** Optional previous key for rotation: "<id>:<base64>" */
    ENCRYPTION_KEY_PREVIOUS: z
      .string()
      .regex(/^[a-z0-9]{1,16}:.+$/i)
      .optional(),

    SESSION_SECRET: z.string().min(32, 'must be at least 32 characters'),
    SESSION_TTL_SEC: z.coerce.number().int().min(300).max(7 * 86400).default(12 * 3600),
    INIT_DATA_MAX_AGE_SEC: z.coerce.number().int().min(60).max(7 * 86400).default(86400),

    PUBLIC_API_URL: z.string().url().optional(),
    MINIAPP_URL: z.string().url().optional(),
    CORS_ORIGINS: z.string().default('http://localhost:5173,http://localhost:5174'),
    TRUST_PROXY: bool.default('false'),

    FIREBASE_PROJECT_ID: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production') {
      for (const key of ['PUBLIC_API_URL', 'MINIAPP_URL'] as const) {
        if (!env[key]) ctx.addIssue({ code: 'custom', path: [key], message: 'required in production' });
      }
      if (env.STORAGE_DRIVER === 'local') {
        ctx.addIssue({ code: 'custom', path: ['STORAGE_DRIVER'], message: 'local storage is for development only' });
      }
    }
    if (env.STORAGE_DRIVER === 'firestore' && !env.FIREBASE_PROJECT_ID) {
      ctx.addIssue({ code: 'custom', path: ['FIREBASE_PROJECT_ID'], message: 'required when STORAGE_DRIVER=firestore' });
    }
  });

export type Env = z.infer<typeof envSchema>;

/** Validates process env. Error output lists variable names only, never values. */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n${lines.join('\n')}`);
  }
  return parsed.data;
}

export function corsOrigins(env: Env): string[] {
  return env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
}
