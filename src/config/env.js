const dotenv = require('dotenv');
const { z } = require('zod');

dotenv.config({ quiet: true });

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3000),
  API_PREFIX: z.string().default('/api'),
  DB_HOST: z.string().default('27.254.134.22'),
  DB_PORT: z.coerce.number().default(3306),
  DB_NAME: z.string().default('zonedevn_jonglock'),
  DB_USER: z.string().default('zonedevn_jonglock'),
  DB_PASSWORD: z.string().min(1),
  DB_CONNECTION_LIMIT: z.coerce.number().default(10),
  JWT_SECRET: z.string().min(32),
  JWT_EXPIRES_IN: z.string().default('8h'),
  MOBILE_JWT_EXPIRES_IN: z.string().default('30d'),
  FIELD_ENCRYPTION_KEY: z.string().min(32),
  FIELD_HASH_SECRET: z.string().min(16),
  CORS_ORIGINS: z.string().default('*'),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().default(15 * 60 * 1000),
  RATE_LIMIT_MAX: z.coerce.number().default(300),
  CRON_SECRET: z.string().default(''),
  FIREBASE_SERVICE_ACCOUNT_JSON: z.string().default(''),
  FIREBASE_PROJECT_ID: z.string().default(''),
  FIREBASE_CLIENT_EMAIL: z.string().default(''),
  FIREBASE_PRIVATE_KEY: z.string().default(''),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const message = parsed.error.issues
    .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
    .join(', ');
  throw new Error(`Invalid environment: ${message}`);
}

const env = parsed.data;

module.exports = {
  ...env,
  corsOrigins: env.CORS_ORIGINS === '*' ? '*' : env.CORS_ORIGINS.split(',').map((origin) => origin.trim()),
};
