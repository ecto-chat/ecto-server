import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { config } from '../config/index.js';
import * as schema from './schema/index.js';

const SLOW_QUERY_THRESHOLD_MS = 200;

export function getPgDb() {
  const pool = new pg.Pool({
    connectionString: config.DATABASE_URL,
    max: config.DB_POOL_MAX ?? 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });

  // Log slow queries by hooking into pg client query execution
  pool.on('connect', (client: pg.PoolClient) => {
    const originalQuery = client.query.bind(client);
    (client as any).query = (...args: any[]) => {
      const start = performance.now();
      const queryText =
        typeof args[0] === 'string' ? args[0] : (args[0]?.text ?? '');

      const result = (originalQuery as any)(...args);

      if (result && typeof result.then === 'function') {
        result.then(
          () => {
            const ms = performance.now() - start;
            if (ms > SLOW_QUERY_THRESHOLD_MS) {
              console.warn(
                `[slow-query] ${ms.toFixed(1)}ms — ${queryText.slice(0, 200)}`,
              );
            }
          },
          () => {
            // Query failed — no timing log needed
          },
        );
      }
      return result;
    };
  });

  return drizzle(pool, { schema });
}
