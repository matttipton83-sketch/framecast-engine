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

async function createCheckout({ jobId, baseUrl, returnTo }) {
  const rt = returnTo || baseUrl;   // where to send the user back (the UI origin)
  if (LIVE) {
    // One-time payment for THIS video. No subscriptions — pay once, no account.
    const session = await stripe.checkout.sessions.create({
      success_url: `${rt}/?paid=${jobId}&session={CHECKOUT_SESSION_ID}`,
      cancel_url: `${rt}/?canceled=${jobId}`,
      metadata: { jobId, plan: 'single' },
      mode: 'payment',
      line_items: [{
        price_data: {
          currency: PRICING.currency,
          product_data: { name: 'Framecast — clean video export' },
          unit_amount: PRICING.perVideoCents,
        },
        quantity: 1,
      }],
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

module.exports = { createCheckout, verifyPaid, verifyWebhook, LIVE, PRICING };
