// tiers.js — what each tier gets, and what it costs.
// Pricing is the lever Matt cares about: a one-time user should never hit a
// subscription wall. So the default paid path is PER-VIDEO, with an optional
// subscription for power users.

const TIERS = {
  // Free: a fast 10-second watermarked TEASER at 540p with the fastest encode.
  // Bounded no matter how long the upload is — keeps free-tier compute cheap and
  // makes previews feel near-instant. Users pay to unlock the full, clean video.
  free: {
    label: 'Free preview',
    watermark: true,
    maxHeight: 540,
    quality: 'preview',
    allow4k: false,
    maxDurationSec: 10,
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
  return { watermark: t.watermark, maxHeight: t.maxHeight, quality: t.quality, allow4k: t.allow4k, maxDurationSec: t.maxDurationSec };
}

module.exports = { TIERS, PRICING, tierOpts };
