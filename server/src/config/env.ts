import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Environment loading
// Load the first .env found: process cwd, the server package dir, then the
// repository root. Secrets live only here — never in client code.
// ---------------------------------------------------------------------------
const candidates = [
  path.resolve(process.cwd(), '.env'),
  path.resolve(__dirname, '../../.env'),
  path.resolve(__dirname, '../../../.env'),
];
for (const candidate of candidates) {
  if (fs.existsSync(candidate)) {
    dotenv.config({ path: candidate });
    break;
  }
}

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  APP_BASE_URL: z.string().default(''),

  JWT_SECRET: z
    .string()
    .min(16, 'JWT_SECRET must be at least 16 characters — generate one with: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"'),
  JWT_REFRESH_SECRET: z
    .string()
    .min(16, 'JWT_REFRESH_SECRET must be at least 16 characters — it must differ from JWT_SECRET'),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL: z.string().default('7d'),

  DATABASE_URL: z
    .string()
    .optional()
    .transform((value) => (value && value.trim().length > 0 ? value.trim() : undefined)),

  EMBEDDED_PG_DIR: z.string().default('.data/postgres'),
  EMBEDDED_PG_PORT: z.coerce.number().int().min(1024).max(65535).default(54329),
  EMBEDDED_PG_PASSWORD: z.string().min(8),
  APP_DB_NAME: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, 'APP_DB_NAME must be a valid identifier'),
  APP_DB_USER: z.string().regex(/^[a-z_][a-z0-9_]*$/, 'APP_DB_USER must be a valid lowercase identifier'),
  APP_DB_PASSWORD: z.string().min(8),

  VOZCORE_PORT: z.coerce.number().int().min(1).max(65535).default(8001),

  GITHUB_CLIENT_ID: z.string().default(''),
  GITHUB_CLIENT_SECRET: z.string().default(''),
  GOOGLE_CLIENT_ID: z.string().default(''),
  GOOGLE_CLIENT_SECRET: z.string().default(''),
  NOTION_CLIENT_ID: z.string().default(''),
  NOTION_CLIENT_SECRET: z.string().default(''),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('\n✖ Invalid VozPilot environment configuration:\n');
  for (const issue of parsed.error.issues) {
    console.error(`  • ${issue.path.join('.') || '(root)'}: ${issue.message}`);
  }
  console.error('\n  Fix your .env file (see .env.example) and restart.\n');
  process.exit(1);
}

export const env = Object.freeze(parsed.data);
export const isProduction = env.NODE_ENV === 'production';
