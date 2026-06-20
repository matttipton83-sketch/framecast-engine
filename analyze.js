// analyze.js — Framecast smart analysis
// Phase 1: loop detection + blank/garbled frame detection.
//
// This module is deterministic signal processing over the per-frame "signatures"
// the render probe already collects (one sample every stepMs). It contains NO
// browser and NO ffmpeg — every exported function is pure and unit-testable.
//
// A signature is: { size:Number, hash:BigInt }  where
//   size = byte length of the probe's small JPEG (cheap motion proxy, already kept)
//   hash = 64-bit average-perceptual-hash (aHash) of the frame (robust similarity)
//
// The render engine builds `hash` from the probe screenshot via frameSignature()
// (the only function here that touches an image decoder); everything downstream
// works on plain arrays of {size, hash} and synthetic fixtures in the tests.

'use strict';

// ----------------------------------------------------------------------------
// Perceptual hashing (pure)
// ----------------------------------------------------------------------------

// 8x8 average hash from a 64-length grayscale grid (row-major, 0..255).
// Bit i is set when gray[i] >= mean(gray). Returns a 64-bit BigInt fingerprint.
// A perfectly flat frame -> all bits set (popcount 64): used as a "no structure"
// signal by the blank detector.
function aHashFromGray(gray) {
  const n = gray.length;
  if (!n) return 0n;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += gray[i];
  const mean = sum / n;
  let h = 0n;
  for (let i = 0; i < n; i++) {
    if (gray[i] >= mean) h |= (1n << BigInt(i));
  }
  return h;
}

// Hamming distance between two 64-bit aHashes (0..64).
function hamming(a, b) {
  let x = a ^ b;
  let d = 0;
  while (x) { x &= (x - 1n); d++; }
  return d;
}

// Number of set bits (0..64). Used to spot structureless (blank) frames.
function popcount(a) {
  let x = a, d = 0;
  while (x) { x &= (x - 1n); d++; }
  return d;
}

// ----------------------------------------------------------------------------
// Image reduction (pure) — turn a raw RGBA buffer into an 8x8 gray grid
// ----------------------------------------------------------------------------

// Box-average an WxH RGBA buffer down to an 8x8 grayscale grid (length 64).
// Luma = Rec.601. Pure: takes a Uint8Array/Array of RGBA, returns number[64].
function rgbaTo8x8Gray(rgba, w, h) {
  const out = new Array(64).fill(0);
  const cnt = new Array(64).fill(0);
  for (let y = 0; y < h; y++) {
    const gy = Math.min(7, (y * 8 / h) | 0);
    for (let x = 0; x < w; x++) {
      const gx = Math.min(7, (x * 8 / w) | 0);
      const p = (y * w + x) * 4;
      const luma = 0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2];
      const cell = gy * 8 + gx;
      out[cell] += luma;
      cnt[cell]++;
    }
  }
  for (let i = 0; i < 64; i++) out[i] = cnt[i] ? out[i] / cnt[i] : 0;
  return out;
}

// ----------------------------------------------------------------------------
// Production glue (the ONLY image-decoder dependency)
// ----------------------------------------------------------------------------

// Decode a probe JPEG buffer -> { size, hash }. Used by render.js per probe frame.
// jpeg-js is pure JS (no native build), safe on the Render box. If decode ever
// fails we still return a usable size + a null hash; callers must tolerate null
// hashes (loop/blank detection simply skip those frames).
function frameSignature(jpegBuffer) {
  const size = jpegBuffer ? jpegBuffer.length : 0;
  try {
    const jpeg = require('jpeg-js');
    const { data, width, height } = jpeg.decode(jpegBuffer, { useTArray: true, maxMemoryUsageInMB: 256 });
    const gray = rgbaTo8x8Gray(data, width, height);
    return { size, hash: aHashFromGray(gray) };
  } catch (e) {
    return { size, hash: null };
  }
}

// ----------------------------------------------------------------------------
// Loop detection (pure)
// ----------------------------------------------------------------------------

const LOOP_DEFAULTS = {
  sameThresh: 6,      // hamming <= this => "the same frame" (out of 64)
  matchRatio: 0.82,   // fraction of lag-paired frames that must match
  movementThresh: 8,  // a real loop must MOVE this much within one period
  minPeriodSteps: 2,  // ignore 1-step "loops" (jitter)
};

// Find the smallest lag L (in steps) at which the signature series repeats.
// Returns { detected, periodSteps, periodSec, confidence, cycles }.
//
// Why smallest-L: a clip that loops twice in the window matches at L *and* 2L;
// we want the true single-cycle period, so we take the first L that qualifies.
// Why a movement gate: a static/held frame "matches itself" at every lag; that's
// not a loop. We require real variation within the candidate period.
function findLoopPeriod(signatures, stepMs, opts = {}) {
  const cfg = { ...LOOP_DEFAULTS, ...opts };
  const sigs = signatures.filter((s) => s && s.hash != null);
  const n = sigs.length;
  const none = { detected: false, periodSteps: 0, periodSec: 0, confidence: 0, cycles: 0 };
  if (n < 4) return none;

  const hashes = sigs.map((s) => s.hash);
  // Need at least ~2 cycles in the window to trust a period -> L <= n/2.
  const maxL = Math.floor(n / 2);

  for (let L = cfg.minPeriodSteps; L <= maxL; L++) {
    // 1) movement gate: does the content actually change across one period?
    let move = 0;
    for (let i = 1; i < L && i < n; i++) {
      const d = hamming(hashes[0], hashes[i]);
      if (d > move) move = d;
    }
    if (move < cfg.movementThresh) continue; // static/near-static — not a loop

    // 2) periodicity GATE: the first cycle [0,L) must match the second cycle
    //    [L,2L). This is the decisive test — it rejects "play once then hold on an
    //    end card" (first cycle is in the moving part, so it won't match the next
    //    cycle) which a whole-window match count would wrongly accept once the
    //    held tail dominates.
    let cPairs = 0, cHits = 0;
    for (let i = 0; i < L && i + L < n; i++) {
      cPairs++;
      if (hamming(hashes[i], hashes[i + L]) <= cfg.sameThresh) cHits++;
    }
    if (cPairs === 0) continue;
    const firstCycleRatio = cHits / cPairs;
    if (firstCycleRatio < cfg.matchRatio) continue;

    // 3) confirmation: how well it repeats across the WHOLE window (drives
    //    confidence and guards against a coincidental single-cycle match).
    let pairs = 0, hits = 0;
    for (let i = 0; i + L < n; i++) {
      pairs++;
      if (hamming(hashes[i], hashes[i + L]) <= cfg.sameThresh) hits++;
    }
    const ratio = pairs ? hits / pairs : firstCycleRatio;
    if (ratio >= cfg.matchRatio) {
      const cycles = +(n / L).toFixed(2);
      // Confidence: how cleanly it repeats, nudged up when more cycles confirm it.
      const confidence = Math.min(0.99, ratio * Math.min(1, 0.6 + 0.2 * (cycles - 1)));
      return {
        detected: true,
        periodSteps: L,
        periodSec: +((L * stepMs) / 1000).toFixed(2),
        confidence: +confidence.toFixed(2),
        cycles,
      };
    }
  }
  return none;
}

// ----------------------------------------------------------------------------
// Blank / garbled frame detection (pure) — Phase 2 ready, ships dark for now
// ----------------------------------------------------------------------------

const BLANK_DEFAULTS = {
  sizeFactor: 0.35,    // "blank" if size < median * this
  structBitsLow: 3,    // popcount <= this  => no structure
  structBitsHigh: 61,  // popcount >= this  => no structure (flat -> all bits set)
  tearThresh: 18,      // isolated frame far from BOTH neighbors => torn frame
};

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Returns { blankRanges:[[startSec,endSec],...], tornSteps:[i,...] }.
// blank  = tiny + structureless (white/black/flat) frame.
// torn   = one-off frame far from both neighbours while the neighbours agree.
function detectBlankRanges(signatures, stepMs, opts = {}) {
  const cfg = { ...BLANK_DEFAULTS, ...opts };
  const n = signatures.length;
  const out = { blankRanges: [], tornSteps: [] };
  if (!n) return out;

  const med = median(signatures.map((s) => (s ? s.size : 0)));
  const isBlank = (s) => {
    if (!s) return true;
    const tiny = med > 0 && s.size < med * cfg.sizeFactor;
    const flat = s.hash != null &&
      (popcount(s.hash) <= cfg.structBitsLow || popcount(s.hash) >= cfg.structBitsHigh);
    return tiny && flat;
  };

  // group consecutive blank frames into ranges (seconds)
  let runStart = -1;
  for (let i = 0; i < n; i++) {
    if (isBlank(signatures[i])) {
      if (runStart < 0) runStart = i;
    } else if (runStart >= 0) {
      out.blankRanges.push([+(runStart * stepMs / 1000).toFixed(2), +(i * stepMs / 1000).toFixed(2)]);
      runStart = -1;
    }
  }
  if (runStart >= 0) out.blankRanges.push([+(runStart * stepMs / 1000).toFixed(2), +(n * stepMs / 1000).toFixed(2)]);

  // isolated torn frames: far from both neighbours, neighbours similar to each other
  for (let i = 1; i < n - 1; i++) {
    const a = signatures[i - 1], b = signatures[i], c = signatures[i + 1];
    if (!a || !b || !c || a.hash == null || b.hash == null || c.hash == null) continue;
    if (hamming(b.hash, a.hash) > cfg.tearThresh &&
        hamming(b.hash, c.hash) > cfg.tearThresh &&
        hamming(a.hash, c.hash) <= (cfg.sameThresh ?? 6)) {
      out.tornSteps.push(i);
    }
  }
  return out;
}

module.exports = {
  aHashFromGray, hamming, popcount, rgbaTo8x8Gray, frameSignature,
  findLoopPeriod, detectBlankRanges, median,
  LOOP_DEFAULTS, BLANK_DEFAULTS,
};
