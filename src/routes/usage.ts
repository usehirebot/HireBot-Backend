import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../db/client';
import { authenticate, AuthenticatedRequest } from '../middleware/authenticate';
import { isEntitled } from '../lib/entitlement';

export const usageRouter = Router();

usageRouter.use(authenticate);

// POST /api/v1/usage/event
// Body: { event_type: string; idempotency_key: string; metadata?: object }
usageRouter.post('/event', async (req: Request, res: Response) => {
  const { userId } = req as AuthenticatedRequest;
  const { event_type, idempotency_key, metadata = {} } = req.body as {
    event_type?: string;
    idempotency_key?: string;
    metadata?: Record<string, unknown>;
  };

  if (!event_type || typeof event_type !== 'string') {
    res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'event_type is required' } });
    return;
  }

  const key = idempotency_key || uuidv4();

  // Entitlement check: caller must be inside a session they've started
  // (POST /billing/start-session) — see lib/entitlement.ts.
  const credits = await db.query<{ active_session_started_at: Date | null }>(
    `SELECT active_session_started_at FROM session_credits WHERE user_id = $1 LIMIT 1`,
    [userId],
  );

  if (credits.rowCount === 0 || !isEntitled(credits.rows[0])) {
    res.status(402).json({ error: { code: 'NO_ACTIVE_SESSION', message: 'Start a session before using this feature' } });
    return;
  }

  // Record event (idempotent — duplicate keys are silently ignored)
  await db.query(
    `INSERT INTO usage_events (user_id, event_type, idempotency_key, metadata)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [userId, event_type, key, JSON.stringify(metadata)],
  );

  res.json({ success: true, idempotency_key: key });
});

// GET /api/v1/usage/me — return usage count for the current billing period
usageRouter.get('/me', async (req: Request, res: Response) => {
  const { userId } = req as AuthenticatedRequest;

  const result = await db.query<{ count: string; period_start: Date; period_end: Date }>(
    `SELECT count, period_start, period_end
     FROM usage_counters
     WHERE user_id = $1 AND period_end > now()
     ORDER BY period_start DESC LIMIT 1`,
    [userId],
  );

  res.json({ usage: result.rows[0] ?? null });
});
