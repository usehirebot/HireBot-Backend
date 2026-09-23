import Razorpay from 'razorpay';

// Lazily constructed: constructing eagerly at module load would crash the
// whole server (auth included) the moment it started with no Razorpay keys
// configured — see the equivalent comment this replaced in the old
// lib/stripe.ts for the incident that taught us that the hard way.
let _razorpay: Razorpay | null = null;

export function getRazorpay(): Razorpay {
  if (!_razorpay) {
    if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
      throw new Error('RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET are not configured');
    }
    _razorpay = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET,
    });
  }
  return _razorpay;
}

export type PackId = 'single' | 'five';

// One-time prepaid session packs — no subscription, no free trial. Amounts
// are in paise (Razorpay's minor currency unit for INR, same convention as
// Stripe's): 9900 = ₹99. Encoded here rather than pre-created Razorpay
// Plans/Items so a price change is a one-line edit, not a dashboard trip.
export const SESSION_PACKS: Record<PackId, { sessions: number; amountMinor: number; label: string }> = {
  single: { sessions: 1, amountMinor: 9900, label: '1 Interview Session' },
  five: { sessions: 5, amountMinor: 29900, label: '5 Interview Sessions' },
};
