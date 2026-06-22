// payments.js — one-time "pay per video" checkout.
//
// Real mode: set STRIPE_SECRET_KEY (and `npm i stripe`). We create a Stripe
// Checkout Session for a single payment and verify it before unlocking.
//
// Dev mode (no key): a built-in fake checkout page lets you click "Pay" and
// test the entire free→pay→clean flow locally with zero setup.

const { PRICING } = require('./tiers');

let stripe = null;
const KEY = process.env.STRIPE_SECRET_KEY;
if (KEY) {
  try { stripe = require('stripe')(KEY); }
  catch (_) { console.warn('stripe key set but `stripe` package not installed — falling back to dev mode'); }
}
const LIVE = !!stripe;
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
// Publishable key (pk_live_… / pk_test_…) is needed by the browser to mount the
// embedded Checkout. If it's set AND we're live, the studio shows the in-page
// modal; otherwise everything falls back to the hosted redirect automatically.
const PUBLISHABLE_KEY = process.env.STRIPE_PUBLISHABLE_KEY || '';
const EMBEDDED_OK = LIVE && !!PUBLISHABLE_KEY;

// Shared line item so hosted + embedded sessions price identically.
function lineItems() {
  return [{
    price_data: {
      currency: PRICING.currency,
      product_data: { name: 'Framecast — clean video export' },
      unit_amount: PRICING.perVideoCents,
    },
    quantity: 1,
  }];
}

async function createCheckout({ jobId, baseUrl, returnTo, embedded }) {
  const rt = returnTo || baseUrl;   // where to send the user back (the UI origin)
  if (LIVE) {
    // Embedded: Stripe's payment UI mounts inside a modal on our own page. It
    // uses return_url (not success/cancel) and redirects the parent window back
    // there on completion — so the existing ?paid= recovery flow still applies.
    if (embedded && EMBEDDED_OK) {
      const session = await stripe.checkout.sessions.create({
        ui_mode: 'embedded',
        return_url: `${rt}/?paid=${jobId}&session={CHECKOUT_SESSION_ID}`,
        metadata: { jobId, plan: 'single' },
        mode: 'payment',
        line_items: lineItems(),
      });
      return { clientSecret: session.client_secret, sessionId: session.id };
    }
    // Hosted (full-page redirect) — the original behaviour, also the fallback.
    const session = await stripe.checkout.sessions.create({
      success_url: `${rt}/?paid=${jobId}&session={CHECKOUT_SESSION_ID}`,
      cancel_url: `${rt}/?canceled=${jobId}`,
      metadata: { jobId, plan: 'single' },
      mode: 'payment',
      line_items: lineItems(),
    });
    return { url: session.url, sessionId: session.id };
  }
  // dev fallback: our own fake checkout screen (returns the user to the UI origin)
  return { url: `/api/dev-checkout?jobId=${encodeURIComponent(jobId)}&returnTo=${encodeURIComponent(rt)}`, sessionId: 'dev' };
}

// Returns true if this job's payment is confirmed.
async function verifyPaid({ sessionId }) {
  if (!LIVE) return true; // dev mode trusts the dev-checkout click
  if (!sessionId || sessionId === 'dev') return false;
  const s = await stripe.checkout.sessions.retrieve(sessionId);
  return s && s.payment_status === 'paid';
}

// Verify a Stripe webhook signature and return the event (or null if not configured).
// Lets us record a payment server-side even if the buyer's browser misses the redirect.
function verifyWebhook(rawBody, signature) {
  if (!LIVE || !WEBHOOK_SECRET) return null;
  return stripe.webhooks.constructEvent(rawBody, signature, WEBHOOK_SECRET);
}

module.exports = { createCheckout, verifyPaid, verifyWebhook, LIVE, EMBEDDED_OK, PUBLISHABLE_KEY, PRICING };
