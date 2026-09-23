import { Pool } from 'pg';
import { ipv4PreferringStream } from './ipv4Socket';

// DATABASE_URL should point at Neon's pooled connection endpoint (hostname
// contains "-pooler"), not the direct one — the direct endpoint has a low
// connection ceiling that this Pool (max 10 per process) will exhaust the
// moment more than a couple of backend instances run concurrently.
export const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  stream: ipv4PreferringStream,
  // rejectUnauthorized: true is safe here — Neon (and most managed Postgres)
  // present a publicly-trusted cert, so this still validates against the
  // system CA store rather than skipping verification.
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: true } : false,
  max: parseInt(process.env.DB_POOL_MAX || '10', 10),
  idleTimeoutMillis: 30_000,
  // Neon's serverless compute suspends after inactivity and can take several
  // seconds to wake on the next connection ("cold start") — 3s was too
  // tight and produced a real connection-timeout error under normal idle
  // conditions, not just under an outage.
  connectionTimeoutMillis: 10_000,
});

db.on('error', (err) => {
  console.error('[db] unexpected pool error', err);
});
