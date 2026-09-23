// Shared "does this user currently have access" check — used by usage.ts's
// entitlement gate and by auth.ts's /me so the client doesn't have to
// duplicate this logic.
//
// Prepaid session-pack model, no trial, no subscription: a user has access
// only while inside a session they explicitly started (POST
// /billing/start-session, which atomically spends one credit from their
// balance) and that session hasn't expired yet.

// How long a single started session grants access for. Not specified by
// the product decision beyond "tapping Start Session consumes it" — this
// is a reasonable default (covers a full interview loop plus buffer) and a
// one-constant change if a different window is wanted.
export const SESSION_DURATION_MS = 4 * 60 * 60 * 1000; // 4 hours

export interface SessionCreditsRow {
  active_session_started_at: Date | null;
}

export function isEntitled(row: SessionCreditsRow, now: Date = new Date()): boolean {
  if (!row.active_session_started_at) return false;
  return now.getTime() - row.active_session_started_at.getTime() < SESSION_DURATION_MS;
}

export function sessionActiveUntil(row: SessionCreditsRow): Date | null {
  if (!row.active_session_started_at) return null;
  return new Date(row.active_session_started_at.getTime() + SESSION_DURATION_MS);
}
