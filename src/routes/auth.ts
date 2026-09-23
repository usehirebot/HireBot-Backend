import { Router, Request, Response } from 'express';
import { verifyToken } from '@clerk/backend';
import crypto from 'crypto';
import { db } from '../db/client';
import { signAccessToken, generateRefreshToken, verifyAccessToken, ACCESS_TOKEN_TTL_SECONDS } from '../lib/tokens';
import { authenticate, AuthenticatedRequest } from '../middleware/authenticate';
import { isEntitled, sessionActiveUntil } from '../lib/entitlement';

export const authRouter = Router();

// POST /api/v1/auth/session
// Body: { id_token: string } — Clerk id_token obtained by the desktop PKCE flow
authRouter.post('/session', async (req: Request, res: Response) => {
  const { id_token } = req.body as { id_token?: string };

  if (!id_token || typeof id_token !== 'string') {
    res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'id_token is required' } });
    return;
  }

  try {
    // Verify Clerk-issued id_token from the desktop OAuth PKCE flow
    const payload = await verifyToken(id_token, {
      secretKey: process.env.CLERK_SECRET_KEY as string,
      authorizedParties: [process.env.CLERK_OAUTH_CLIENT_ID as string],
    });

    const clerkUserId = payload.sub;
    // Clerk includes email in id_token when `email` scope is requested
    const email = (payload as Record<string, unknown>).email as string | undefined;

    if (!email) {
      res.status(400).json({ error: { code: 'MISSING_EMAIL', message: 'Email not present in token; ensure email scope is requested' } });
      return;
    }

    // Upsert user and start a trial subscription atomically
    const client = await db.connect();
    try {
      await client.query('BEGIN');

      const userResult = await client.query<{ id: string; email: string; status: string }>(
        `INSERT INTO users (clerk_user_id, email)
         VALUES ($1, $2)
         ON CONFLICT (clerk_user_id)
         DO UPDATE SET email = EXCLUDED.email, updated_at = now()
         RETURNING id, email, status`,
        [clerkUserId, email],
      );
      const user = userResult.rows[0];

      if (user.status === 'blocked' || user.status === 'suspended') {
        await client.query('ROLLBACK');
        res.status(403).json({ error: { code: 'ACCOUNT_BLOCKED', message: 'This account has been suspended.' } });
        return;
      }

      // Give every user a session_credits row to update later (no free
      // sessions — no trial, balance starts at zero; see 003_session_credits.sql).
      await client.query(
        `INSERT INTO session_credits (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`,
        [user.id],
      );

      // Issue tokens
      const accessToken = signAccessToken(user.id, user.email);
      const { token: refreshToken, hash: refreshTokenHash, expiresAt } = generateRefreshToken();

      const deviceLabel = req.headers['user-agent']?.slice(0, 200) ?? null;
      await client.query(
        `INSERT INTO sessions (user_id, refresh_token_hash, device_label, expires_at)
         VALUES ($1, $2, $3, $4)`,
        [user.id, refreshTokenHash, deviceLabel, expiresAt],
      );

      await client.query('COMMIT');

      res.json({ access_token: accessToken, refresh_token: refreshToken, expires_in: ACCESS_TOKEN_TTL_SECONDS });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[auth] /session error:', err);
    res.status(401).json({ error: { code: 'INVALID_TOKEN', message: 'id_token is invalid or expired' } });
  }
});

// POST /api/v1/auth/refresh
// Body: { refresh_token: string }
authRouter.post('/refresh', async (req: Request, res: Response) => {
  const { refresh_token } = req.body as { refresh_token?: string };

  if (!refresh_token || typeof refresh_token !== 'string') {
    res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'refresh_token is required' } });
    return;
  }

  const tokenHash = crypto.createHash('sha256').update(refresh_token).digest('hex');

  const result = await db.query<{ id: string; user_id: string; email: string; status: string }>(
    `SELECT s.id, s.user_id, u.email, u.status
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.refresh_token_hash = $1
       AND s.revoked_at IS NULL
       AND s.expires_at > now()
     LIMIT 1`,
    [tokenHash],
  );

  if (result.rowCount === 0) {
    res.status(401).json({ error: { code: 'INVALID_REFRESH_TOKEN', message: 'Refresh token is invalid or expired' } });
    return;
  }

  const session = result.rows[0];

  if (session.status === 'blocked' || session.status === 'suspended') {
    res.status(403).json({ error: { code: 'ACCOUNT_BLOCKED', message: 'This account has been suspended.' } });
    return;
  }

  // Rotate the refresh token
  const { token: newRefreshToken, hash: newHash, expiresAt } = generateRefreshToken();

  await db.query(
    `UPDATE sessions
     SET refresh_token_hash = $1, expires_at = $2
     WHERE id = $3`,
    [newHash, expiresAt, session.id],
  );

  const accessToken = signAccessToken(session.user_id, session.email);

  res.json({ access_token: accessToken, refresh_token: newRefreshToken, expires_in: ACCESS_TOKEN_TTL_SECONDS });
});

// POST /api/v1/auth/logout
// Body: { refresh_token: string }
authRouter.post('/logout', async (req: Request, res: Response) => {
  const { refresh_token } = req.body as { refresh_token?: string };

  if (refresh_token) {
    const tokenHash = crypto.createHash('sha256').update(refresh_token).digest('hex');
    await db.query(
      `UPDATE sessions SET revoked_at = now() WHERE refresh_token_hash = $1 AND revoked_at IS NULL`,
      [tokenHash],
    );
  }

  res.json({ success: true });
});

// GET /api/v1/auth/me
authRouter.get('/me', authenticate, async (req: Request, res: Response) => {
  const { userId } = req as AuthenticatedRequest;

  const result = await db.query<{
    id: string; email: string; status: string; created_at: Date;
    balance: number; active_session_started_at: Date | null;
  }>(
    `SELECT u.id, u.email, u.status, u.created_at,
            sc.balance, sc.active_session_started_at
     FROM users u
     LEFT JOIN session_credits sc ON sc.user_id = u.id
     WHERE u.id = $1
     LIMIT 1`,
    [userId],
  );

  if (result.rowCount === 0) {
    res.status(404).json({ error: { code: 'USER_NOT_FOUND', message: 'User not found' } });
    return;
  }

  const row = result.rows[0];
  const is_active = isEntitled({ active_session_started_at: row.active_session_started_at });

  res.json({
    user: {
      id: row.id,
      email: row.email,
      status: row.status,
      created_at: row.created_at,
      sessions_remaining: row.balance ?? 0,
      is_active,
      session_active_until: sessionActiveUntil({ active_session_started_at: row.active_session_started_at }),
    },
  });
});

// POST /api/v1/auth/logout-all — revoke all sessions for the current user
authRouter.post('/logout-all', authenticate, async (req: Request, res: Response) => {
  const { userId } = req as AuthenticatedRequest;
  await db.query(
    `UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId],
  );
  res.json({ success: true });
});
