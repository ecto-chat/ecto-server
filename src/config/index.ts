import { z } from 'zod/v4';

const envSchema = z.object({
  DATABASE_URL: z.string().optional(),
  DATABASE_TYPE: z.enum(['pg', 'sqlite']).default('pg'),
  DATABASE_PATH: z.string().default('./data/ecto.db'),
  JWT_SECRET: z.string().min(1),
  CENTRAL_URL: z.string().url().optional(),
  PORT: z.coerce.number().default(3000),
  MEDIASOUP_MIN_PORT: z.coerce.number().default(40000),
  MEDIASOUP_MAX_PORT: z.coerce.number().default(40100),
  UPLOAD_DIR: z.string().default('./data/uploads'),
  SERVER_ADDRESS: z.string().optional(),
  HOSTING_MODE: z.enum(['self-hosted', 'managed']).default('self-hosted'),
  ALLOW_LOCAL_ACCOUNTS: z
    .string()
    .default('true')
    .transform((v) => v !== 'false'),
  // Per-server storage quota in bytes (0 = unlimited, default for self-hosted)
  STORAGE_QUOTA_BYTES: z.coerce.number().default(0),
  // Per-file max upload size in bytes (0 = use server_config value)
  MAX_UPLOAD_SIZE_BYTES: z.coerce.number().default(0),
});

export type Config = z.infer<typeof envSchema>;
export const config = envSchema.parse(process.env);
