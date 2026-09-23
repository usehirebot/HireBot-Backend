import { Request, Response, NextFunction } from 'express';
import { verifyAccessToken } from '../lib/tokens';
import { db } from '../db/client';

export interface AuthenticatedRequest extends Request {
  userId: string;
  userEmail: string;
}

export async function authenticate(req: Request, res: Response, next: NextFunction): Promise<void> {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Missing Authorization header' } });
    return;
  }

  let payload;
  try {
    payload = verifyAccessToken(auth.slice(7));
  } catch {
    res.status(401).json({ error: { code: 'TOKEN_EXPIRED', message: 'Access token expired or invalid' } });
    return;
  }

  // The JWT alone only proves "this was a valid user at issuance time" — it
  // says nothing about *now*. Without this, blocking a user's account has no
  // effect until their token happens to expire (up to ACCESS_TOKEN_TTL_SECONDS
  // later): the old token keeps authorizing billing/usage requests right up
  // until then. /session and /refresh already check status at issuance; this
  // is what makes a block take effect on the very next request instead.
  const result = await db.query<{ status: string }>('SELECT status FROM users WHERE id = $1', [payload.sub]);
  const status = result.rows[0]?.status;

  if (!status) {
    res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Account not found' } });
    return;
  }
  if (status === 'blocked' || status === 'suspended') {
    res.status(403).json({ error: { code: 'ACCOUNT_BLOCKED', message: 'This account has been suspended.' } });
    return;
  }

  (req as AuthenticatedRequest).userId = payload.sub;
  (req as AuthenticatedRequest).userEmail = payload.email;
  next();
}
