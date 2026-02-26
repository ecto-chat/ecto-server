import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from './schema/index.js';

export type Db = NodePgDatabase<typeof schema>;

let _db: Db | null = null;

export async function getDb(): Promise<Db> {
  if (_db) return _db;
  const { getPgDb } = await import('./pg.js');
  _db = getPgDb();
  return _db;
}

export function db(): Db {
  if (!_db) throw new Error('Database not initialized. Call getDb() first.');
  return _db;
}
