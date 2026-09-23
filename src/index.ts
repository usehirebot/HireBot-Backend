import 'dotenv/config';
// Must load before the route files below create their Routers: it patches
// express.Router/application so a rejected promise in an async handler is
// forwarded to the error middleware instead of crashing the process (Express
// 4 does not do this natively — that's what actually took the server down
// during a Neon cold-start connection timeout).
import 'express-async-errors';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { authRouter } from './routes/auth';
import { usageRouter } from './routes/usage';
import { billingRouter, billingWebhookHandler } from './routes/billing';

const app = express();
const PORT = parseInt(process.env.PORT || '3001', 10);

// ── Security headers ──────────────────────────────────────────────────────────
app.use(helmet());

// ── CORS — only the desktop app origin should need this ──────────────────────
app.use(cors({ origin: false, credentials: false }));

// ── Razorpay webhook — MUST be registered with a raw body parser before the
// global express.json() below. Razorpay's signature verification needs the
// exact raw request bytes; once express.json() has parsed a request body,
// that raw form is gone. ───────────────────────────────────────────────────
app.post('/api/v1/billing/webhook', express.raw({ type: 'application/json' }), billingWebhookHandler);

// ── Body parsing (everything after this point gets a parsed JSON body) ───────
app.use(express.json({ limit: '256kb' }));

// ── Rate limiting ─────────────────────────────────────────────────────────────
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many requests, please slow down' } },
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many requests' } },
});

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/api/v1/auth', authLimiter, authRouter);
app.use('/api/v1/usage', apiLimiter, usageRouter);
app.use('/api/v1/billing', apiLimiter, billingRouter);

app.get('/health', (_req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

// ── Generic error handler — never expose stack traces ────────────────────────
app.use((_err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[server] unhandled error:', _err);
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' } });
});

app.listen(PORT, () => {
  console.log(`[server] HireBot API listening on port ${PORT} (${process.env.NODE_ENV ?? 'development'})`);
});
