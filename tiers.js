// tiers.js — what each tier gets, and what it costs.
// Pricing is the lever Matt cares about: a one-time user should never hit a
// subscription wall. So the default paid path is PER-VIDEO, with an optional
// subscription for power users.

const TIERS = {
  // Free: instant, but watermarked and capped at 720p. Cheap to render, which is
  // the point — you only spend real compute on people who pay.
  free: {
    label: 'Free preview',
    watermark: true,
    maxHeight: 720,
    quality: 'balanced',
    allow4k: false,
  },
  // Paid (per-video OR subscription unlock): clean, full resolution, all formats.
  paid: {
    label: 'Clean export',
    watermark: false,
    maxHeight: null,   // up to the preset's native resolution (incl. 4K)
    quality: 'high',
    allow4k: true,
  },
};

const PRICING = {
  currency: 'usd',
  perVideoCents: 299,        // $2.99 to unlock one clean video — tweak freely
  proMonthlyCents: 900,      // $9/mo optional subscription (unlimited clean)
  perVideoLabel: '$2.99',
  proMonthlyLabel: '$9/mo',
};

function tierOpts(tier) {
  const t = TIERS[tier] || TIERS.free;
  return { watermark: t.watermark, maxHeight: t.maxHeight, quality: t.quality, allow4k: t.allow4k };
}

module.exports = { TIERS, PRICING, tierOpts };
