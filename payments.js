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

async function createCheckout({ jobId, baseUrl, returnTo }) {
  const rt = returnTo || baseUrl;   // where to send the user back (the UI origin)
  if (LIVE) {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{
        price_data: {
          currency: PRICING.currency,
          product_data: { name: 'Framecast — clean video export' },
          unit_amount: PRICING.perVideoCents,
        },
        quantity: 1,
      }],
      success_url: `${rt}/?paid=${jobId}&session={CHECKOUT_SESSION_ID}`,
      cancel_url: `${rt}/?canceled=${jobId}`,
      metadata: { jobId },
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

module.exports = { createCheckout, verifyPaid, LIVE, PRICING };
