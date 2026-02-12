import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { config } from '../config/index.js';
import * as schema from './schema/index.js';

export function getPgDb() {
  const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
  return drizzle(pool, { schema });
}
