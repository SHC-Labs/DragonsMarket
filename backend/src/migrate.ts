import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type pg from 'pg';
import { createPool } from './database.js';
import { readConfig } from './config.js';

const MIGRATION_STATEMENT_TIMEOUT = '30min';

export async function migrationFiles(directory = resolve('migrations')) {
  const names = (await readdir(directory)).filter(name => /^\d+_[a-z0-9_]+\.sql$/.test(name)).sort();
  if (!names.length) throw new Error('No migrations found');
  return Promise.all(names.map(async name => {
    const sql = await readFile(resolve(directory, name), 'utf8');
    return { name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
  }));
}

export async function migrate(pool: pg.Pool, directory?: string) {
  const files = await migrationFiles(directory);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // The pool's 3 second limit is for API queries. An index build on a large table needs far longer.
    await client.query(`SET LOCAL statement_timeout = '${MIGRATION_STATEMENT_TIMEOUT}'`);
    await client.query("SELECT pg_advisory_xact_lock(704346941)");
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
    const { rows } = await client.query('SELECT version, checksum FROM schema_migrations ORDER BY version');
    if (rows.length > files.length || rows.some((row, i) => row.version !== files[i]?.name || row.checksum !== files[i]?.checksum)) throw new Error('Applied migration changed or is missing; restore it and add a new migration');
    for (const file of files.slice(rows.length)) {
      await client.query(file.sql);
      await client.query('INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)', [file.name, file.checksum]);
    }
    await client.query('COMMIT');
    return files.length - rows.length;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let pool: pg.Pool | undefined;
  try {
    const config = readConfig({ DATABASE_URL: process.env.DATABASE_URL });
    pool = createPool(config.databaseUrl);
    console.log(`Applied ${await migrate(pool)} migration(s)`);
  }
  catch (error) { console.error(`Migration failed: ${error instanceof Error ? error.message : 'unknown error'}`); process.exitCode = 1; }
  finally { await pool?.end(); }
}
