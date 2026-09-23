import jwt from 'jsonwebtoken';
import crypto from 'crypto';

export function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`${name} env var is required`);
  return val;
}

const JWT_EXPIRES_IN = (process.env.JWT_EXPIRES_IN || '15m') as jwt.SignOptions['expiresIn'];
const REFRESH_EXPIRES_DAYS = parseInt(process.env.REFRESH_TOKEN_EXPIRES_DAYS || '30', 10);

// Derive TTL in seconds from the same value used to sign — never hardcode 900 elsewhere.
function parseExpiryToSeconds(expiresIn: string): number {
  const match = /^(\d+)([smhd])$/.exec(expiresIn);
  if (!match) return 900;
  const [, num, unit] = match;
  const multipliers: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };
  return parseInt(num, 10) * multipliers[unit];
}

export const ACCESS_TOKEN_TTL_SECONDS = parseExpiryToSeconds(JWT_EXPIRES_IN as string);

export interface AccessTokenPayload {
  sub: string;   // user UUID from our DB (not Clerk's)
  email: string;
}

export function signAccessToken(userId: string, email: string): string {
  return jwt.sign({ sub: userId, email } satisfies AccessTokenPayload, requireEnv('JWT_SECRET'), {
    expiresIn: JWT_EXPIRES_IN,
  });
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  return jwt.verify(token, requireEnv('JWT_SECRET')) as AccessTokenPayload;
}

export function generateRefreshToken(): { token: string; hash: string; expiresAt: Date } {
  const token = crypto.randomBytes(48).toString('base64url');
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + REFRESH_EXPIRES_DAYS);
  return { token, hash, expiresAt };
}
