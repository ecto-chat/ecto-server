import { config } from '../config/index.js';

export async function getDb() {
  if (config.DATABASE_TYPE === 'sqlite') {
    const { getSqliteDb } = await import('./sqlite.js');
    return getSqliteDb();
  }
  const { getPgDb } = await import('./pg.js');
  return getPgDb();
}
