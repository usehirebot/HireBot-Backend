import { Router, Request, Response } from 'express';
import { validateWebhookSignature, validatePaymentVerification } from 'razorpay/dist/utils/razorpay-utils';
import { db } from '../db/client';
import { getRazorpay, SESSION_PACKS, PackId } from '../lib/razorpay';
import { authenticate, AuthenticatedRequest } from '../middleware/authenticate';

// ── JSON-body routes (checkout, start-session, verify-callback) — mounted
// after the app's global express.json() in index.ts, same as auth/usage. ──
export const billingRouter = Router();
billingRouter.use(authenticate);

// POST /api/v1/billing/checkout-session
// Body: { pack: 'single' | 'five', success_url }
// Creates a Razorpay Payment Link for a one-time purchase of a session
// pack. success_url points at the desktop app's own loopback callback
// server (the same pattern AuthHelper.ts uses for the PKCE login redirect)
// — the backend doesn't know what port the client's loopback server is on.
// No cancel_url: Payment Links only support a single callback_url, fired
// on success; an abandoned link simply never calls back and the client
// times out waiting, same as an abandoned login attempt.
billingRouter.post('/checkout-session', async (req: Request, res: Response) => {
  const { userId, userEmail } = req as AuthenticatedRequest;
  const { pack, success_url } = req.body as { pack?: PackId; success_url?: string };

  if (pack !== 'single' && pack !== 'five') {
    res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'pack must be single or five' } });
    return;
  }
  if (!success_url) {
    res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'success_url is required' } });
    return;
  }

  const packDef = SESSION_PACKS[pack];

  // NOTE: `contact` (phone number) is optional in Razorpay's type for this
  // call, but Payment Links have been reported to require one in practice
  // for some account configurations. The app doesn't collect a phone
  // number anywhere today (Clerk auth only provides email) — verify this
  // actually works with a real test-mode key before shipping; if Razorpay
  // rejects it, a phone-collection step will need to be added.
  const paymentLink = await getRazorpay().paymentLink.create({
    amount: packDef.amountMinor,
    currency: 'INR',
    description: packDef.label,
    customer: { email: userEmail },
    notify: { email: true, sms: false },
    notes: { user_id: userId, pack_size: String(packDef.sessions) },
    callback_url: success_url,
    callback_method: 'get',
  });

  res.json({ url: paymentLink.short_url });
});

// POST /api/v1/billing/start-session
// Spends one credit from the caller's balance and opens a 4-hour access
// window (see SESSION_DURATION_MS in lib/entitlement.ts). Atomic: the
// balance check and the decrement happen in the same
// UPDATE ... WHERE balance > 0, so two concurrent calls can't both succeed
// against a balance of 1.
billingRouter.post('/start-session', async (req: Request, res: Response) => {
  const { userId } = req as AuthenticatedRequest;

  const result = await db.query<{ balance: number; active_session_started_at: Date }>(
    `UPDATE session_credits
     SET balance = balance - 1, active_session_started_at = now(), updated_at = now()
     WHERE user_id = $1 AND balance > 0
     RETURNING balance, active_session_started_at`,
    [userId],
  );

  if (result.rowCount === 0) {
    res.status(402).json({ error: { code: 'NO_SESSIONS_REMAINING', message: 'No sessions remaining — purchase more to continue' } });
    return;
  }

  res.json({
    sessions_remaining: result.rows[0].balance,
    session_started_at: result.rows[0].active_session_started_at,
  });
});

// POST /api/v1/billing/verify-callback
// Body: the razorpay_* query params the desktop app's loopback server
// received on its callback_url after checkout. Razorpay signs this
// redirect the same way it signs webhooks (HMAC-SHA256 with the webhook
// secret over a specific pipe-joined payload — see
// razorpay/dist/utils/razorpay-utils.js), so a valid signature here is as
// trustworthy as a webhook delivery, just faster: this is what lets the
// desktop app show "payment confirmed" immediately rather than waiting on
// webhook delivery latency. Crediting is idempotent (creditForPaymentLink
// below), so it's safe for this and the webhook to both end up applying
// the same completed purchase — whichever arrives first wins, the second
// is a no-op.
billingRouter.post('/verify-callback', async (req: Request, res: Response) => {
  const { userId } = req as AuthenticatedRequest;
  const {
    razorpay_payment_id,
    razorpay_payment_link_id,
    razorpay_payment_link_reference_id,
    razorpay_payment_link_status,
    razorpay_signature,
  } = req.body as Record<string, string | undefined>;

  if (!razorpay_payment_id || !razorpay_payment_link_id || !razorpay_signature) {
    res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'Missing Razorpay callback parameters' } });
    return;
  }

  const valid = validatePaymentVerification(
    {
      payment_id: razorpay_payment_id,
      payment_link_id: razorpay_payment_link_id,
      payment_link_reference_id: razorpay_payment_link_reference_id ?? '',
      payment_link_status: razorpay_payment_link_status ?? '',
    },
    razorpay_signature,
    process.env.RAZORPAY_WEBHOOK_SECRET as string,
  );

  if (!valid || razorpay_payment_link_status !== 'paid') {
    res.status(400).json({ error: { code: 'INVALID_SIGNATURE', message: 'Could not verify this payment' } });
    return;
  }

  // Fetch the link to read back amount/notes reliably (the callback query
  // params alone don't carry pack size) rather than trusting anything else
  // client-supplied beyond what's already been signature-verified above.
  const link = await getRazorpay().paymentLink.fetch(razorpay_payment_link_id);
  const packSize = parseInt(link.notes?.pack_size as string, 10);
  const linkUserId = link.notes?.user_id as string | undefined;

  if (!packSize || linkUserId !== userId) {
    res.status(400).json({ error: { code: 'PAYMENT_MISMATCH', message: 'Payment does not match this account' } });
    return;
  }

  const credited = await creditForPaymentLink({
    userId,
    paymentLinkId: razorpay_payment_link_id,
    packSize,
    amountMinor: link.amount_paid,
  });

  const balance = await db.query<{ balance: number }>(
    `SELECT balance FROM session_credits WHERE user_id = $1`,
    [userId],
  );

  res.json({ credited, sessions_remaining: balance.rows[0]?.balance ?? 0 });
});

// ── Webhook — mounted in index.ts with express.raw(), BEFORE the app's
// global express.json(), so req.body here is the untouched raw Buffer that
// Razorpay's signature check needs. Exported standalone rather than as
// part of billingRouter above, which requires auth (the webhook isn't a
// logged-in user request — Razorpay's signature IS the authentication),
// and it's the authoritative, eventually-consistent path for crediting a
// purchase even if the client never reaches /verify-callback (app closed
// mid-checkout, network drop on the redirect, etc). ─────────────────────
export async function billingWebhookHandler(req: Request, res: Response): Promise<void> {
  const signature = req.headers['x-razorpay-signature'];
  if (!signature || typeof signature !== 'string') {
    res.status(400).send('Missing X-Razorpay-Signature header');
    return;
  }

  const rawBody = req.body as Buffer;
  const valid = validateWebhookSignature(rawBody.toString(), signature, process.env.RAZORPAY_WEBHOOK_SECRET as string);
  if (!valid) {
    console.error('[billing] webhook signature verification failed');
    res.status(400).send('Invalid signature');
    return;
  }

  let event: RazorpayWebhookPayload;
  try {
    event = JSON.parse(rawBody.toString());
  } catch {
    res.status(400).send('Invalid JSON');
    return;
  }

  try {
    if (event.event === 'payment_link.paid') {
      const link = event.payload?.payment_link?.entity;
      const payment = event.payload?.payment?.entity;
      const packSize = parseInt(link?.notes?.pack_size ?? '', 10);
      const userId = link?.notes?.user_id;

      if (link?.id && userId && packSize) {
        await creditForPaymentLink({
          userId,
          paymentLinkId: link.id,
          packSize,
          amountMinor: payment?.amount ?? link.amount_paid ?? 0,
        });
      }
    } else if (event.event === 'payment.dispute.created' || event.event === 'refund.created') {
      // Chargebacks/refunds need a human look before anything automatic
      // happens to the account — flag it loudly rather than
      // auto-suspending someone who may have a legitimate dispute pending.
      // Log only identifiers/amounts, never the full payload: Razorpay
      // nests the associated Payment entity into these two event types,
      // and that entity carries the customer's email/contact as core
      // fields — JSON.stringify-ing the raw payload here would put PII
      // into plaintext application logs.
      const dispute = event.payload?.dispute?.entity;
      const refund = event.payload?.refund?.entity;
      const payment = event.payload?.payment?.entity;
      console.warn('[billing] ALERT: needs manual review', {
        event: event.event,
        paymentId: payment?.id,
        disputeId: dispute?.id,
        disputeAmount: dispute?.amount,
        disputeReason: dispute?.reason_code,
        refundId: refund?.id,
        refundAmount: refund?.amount,
      });
    }
    // Every other event type is intentionally ignored, but still 200'd
    // below so Razorpay doesn't keep retrying delivery of something we
    // don't act on.

    res.status(200).send('ok');
  } catch (err) {
    console.error(`[billing] error processing webhook event ${event?.event}:`, err);
    res.status(500).send('Processing error');
  }
}

// Idempotent credit application shared by /verify-callback and the
// webhook: INSERT ... ON CONFLICT DO NOTHING on session_purchases is the
// atomic "have we already applied this exact payment link" guard — if the
// row already exists (the other path got there first), this is a no-op.
async function creditForPaymentLink(args: {
  userId: string;
  paymentLinkId: string;
  packSize: number;
  amountMinor: number;
}): Promise<boolean> {
  const purchase = await db.query(
    `INSERT INTO session_purchases (user_id, payment_reference, pack_size, amount_paid_minor, currency)
     VALUES ($1, $2, $3, $4, 'inr')
     ON CONFLICT (payment_reference) DO NOTHING
     RETURNING id`,
    [args.userId, args.paymentLinkId, args.packSize, args.amountMinor],
  );
  if (purchase.rowCount === 0) return false; // already credited by the other path

  await db.query(
    `UPDATE session_credits SET balance = balance + $1, updated_at = now() WHERE user_id = $2`,
    [args.packSize, args.userId],
  );
  return true;
}

interface RazorpayWebhookPayload {
  event: string;
  payload?: {
    payment_link?: {
      entity?: {
        id: string;
        amount_paid?: number;
        notes?: Record<string, string>;
      };
    };
    payment?: {
      entity?: {
        id: string;
        amount?: number;
      };
    };
    // Deliberately narrow: only the non-PII fields the dispute/refund log
    // line above needs. The full entity also carries payment method/
    // notes; add fields here only if a real need shows up, not preemptively.
    dispute?: {
      entity?: {
        id: string;
        amount?: number;
        reason_code?: string;
      };
    };
    refund?: {
      entity?: {
        id: string;
        amount?: number;
      };
    };
  };
}
