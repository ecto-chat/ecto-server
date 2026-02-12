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
});

export type Config = z.infer<typeof envSchema>;
export const config = envSchema.parse(process.env);
