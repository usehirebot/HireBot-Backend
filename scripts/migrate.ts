import 'dotenv/config';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { Pool } from 'pg';
import { ipv4PreferringStream } from '../src/db/ipv4Socket';

const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  stream: ipv4PreferringStream,
  ssl: { rejectUnauthorized: true },
});

// Tracks which migration files have already run. Replaying everything on
// every invocation (the original design here) turned out not to be safe:
// a later migration renaming a table doesn't stop an earlier migration's
// `CREATE TABLE IF NOT EXISTS <old name>` from recreating a stale copy of
// it on the next replay — 003_session_credits.sql hit exactly this against
// 001_initial.sql's `subscriptions` table. Tracking applied filenames and
// only running new ones avoids that whole class of bug.
async function ensureMigrationsTable() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename    TEXT        PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

const dir = join(__dirname, '../src/db/migrations');
const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

async function run() {
  await ensureMigrationsTable();

  const applied = await db.query<{ filename: string }>('SELECT filename FROM schema_migrations');
  const appliedSet = new Set(applied.rows.map((r) => r.filename));

  const pending = files.filter((f) => !appliedSet.has(f));
  if (pending.length === 0) {
    console.log('Nothing to apply — already up to date.');
    await db.end();
    return;
  }

  for (const file of pending) {
    console.log(`Applying ${file}...`);
    const sql = readFileSync(join(dir, file), 'utf8');
    await db.query(sql);
    await db.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
  }
  console.log('Migration complete');
  await db.end();
}

run().catch((e) => {
  console.error(e.message);
  db.end();
  process.exit(1);
});
