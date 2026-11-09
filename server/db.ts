import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import type { Config } from './config.ts';

pg.types.setTypeParser(1082, (value) => value);
export type Row = Record<string, unknown>;
export interface Sql {
  query<T = Row>(text: string, values?: unknown[]): Promise<{ rows: T[] }>;
}
export interface Database extends Sql {
  transaction<T>(work: (sql: Sql) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export async function openDatabase(config: Pick<Config, 'databaseUrl' | 'dataDir' | 'ssl'>): Promise<Database> {
  if (config.databaseUrl) {
    const pool = new pg.Pool({ connectionString: config.databaseUrl, ssl: config.ssl, max: 10 });
    const wrap = (client: pg.Pool | pg.PoolClient): Sql => ({
      async query<T>(text: string, values: unknown[] = []) {
        const result = await client.query(text, values);
        return { rows: result.rows as T[] };
      },
    });
    return {
      ...wrap(pool),
      async transaction<T>(work: (sql: Sql) => Promise<T>) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const value = await work(wrap(client));
          await client.query('COMMIT');
          return value;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
      },
      close: () => pool.end(),
    };
  }
  const db = new PGlite({
    dataDir: config.dataDir === ':memory:' ? 'memory://' : path.join(config.dataDir, 'postgres'),
    parsers: { 1082: (value: string) => value },
  });
  await db.waitReady;
  // PGlite shares one connection, so queue entire transactions together.
  let tail = Promise.resolve();
  const exclusive = <T>(work: () => Promise<T>): Promise<T> => {
    const next = tail.then(work);
    tail = next.then(() => undefined, () => undefined);
    return next;
  };
  return {
    query: <T>(text: string, values: unknown[] = []) => exclusive(() => db.query<T>(text, values)),
    transaction: <T>(work: (sql: Sql) => Promise<T>) => exclusive(() => db.transaction(async (tx) => work({
      query: <R>(text: string, values: unknown[] = []) => tx.query<R>(text, values),
    }))),
    close: () => exclusive(() => db.close()),
  };
}

export async function migrate(db: Database): Promise<void> {
  const sql = await readFile(path.resolve('db/migrations/001_initial.sql'), 'utf8');
  await db.transaction(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(72490311)');
    await tx.query('CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const existing = await tx.query('SELECT version FROM schema_migrations WHERE version = 1');
    if (existing.rows.length) return;
    // This migration contains no values or semicolons inside SQL literals.
    for (const statement of sql.split(';').map((part) => part.trim()).filter(Boolean)) {
      await tx.query(statement);
    }
    await tx.query('INSERT INTO schema_migrations (version) VALUES (1)');
  });
}

export function sqlState(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined;
}
