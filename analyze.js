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

const net = require('net');

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

// ----------------------------------------------------------------------------
// Overlay / play-bar detection (pure scorer + injectable page function)
// ----------------------------------------------------------------------------

// Pure decision table over the raw DOM signals (unit-testable). A baked-in fake
// video player is given away by a timecode label ("0:19 / 1:00"); a wide thin
// progress bar and a play glyph corroborate it. Timecode alone is high
// confidence; bar+play is medium; a lone bar is too weak to act on.
function scoreOverlay({ timecode, bar, play } = {}) {
  const evidence = [];
  if (timecode) evidence.push('timecode');
  if (bar) evidence.push('progress-bar');
  if (play) evidence.push('play-glyph');
  let detected = false, confidence = 0;
  if (timecode) { detected = true; confidence = 0.9; }
  else if (bar && play) { detected = true; confidence = 0.7; }
  else if (bar) { detected = false; confidence = 0.4; }
  return { detected, confidence, evidence };
}

// Self-contained function injected into the page (Playwright serializes it).
// mode:'detect' -> returns a verdict for the confirm card.
// mode:'hide'   -> tags the player-chrome elements so they vanish, and keeps
//                  them hidden across the animation's re-renders via a style rule
//                  + MutationObserver. Only DOM-built bars are found (a canvas-
//                  painted bar exposes no timecode text), and those are exactly
//                  the ones we can cleanly remove.
function overlayPageFn(arg) {
  var mode = (arg && arg.mode) || 'detect';
  var W = window.innerWidth, H = window.innerHeight;
  var reTC = /\b\d{1,2}:\d{2}\s*\/\s*\d{1,2}:\d{2}\b/;
  // The player bar sits at the bottom of the CONTENT STAGE, not the viewport —
  // measure the band relative to the stage (body rect clamped to the viewport).
  function stageRect() {
    var r = document.body ? document.body.getBoundingClientRect() : null;
    if (!r || r.width < 10 || r.height < 10) return { left: 0, top: 0, width: W, height: H };
    return { left: Math.max(0, r.left), top: Math.max(0, r.top), width: Math.min(W, r.width), height: Math.min(H, r.height) };
  }
  var S = stageRect();
  var sW = S.width, sH = S.height, sB = S.top + sH, sL = S.left, sR = S.left + sW;
  var bandTop = S.top + sH * 0.72;
  function inX(r) { return r.left >= sL - 4 && r.right <= sR + 4; }
  function scan() {
    var all = document.body ? document.body.querySelectorAll('*') : [];
    var tc = null, bar = null, play = null;
    for (var i = 0; i < all.length; i++) {
      var el = all[i]; var r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      if (r.bottom < bandTop || r.top > sB + 4 || !inX(r)) continue;
      var t = (el.textContent || '').trim();
      if (!tc && t && t.length <= 30 && reTC.test(t)) tc = el;
      if (!bar && r.width > sW * 0.45 && r.height > 1 && r.height < sH * 0.06) bar = el;
      if (!play && r.width > 6 && r.height > 6 && r.width < sH * 0.12 && r.height < sH * 0.12 && r.left < sL + sW * 0.33) play = el;
    }
    return { tc: tc, bar: bar, play: play };
  }
  function chromeOf(s) {
    if (s.tc) { var n = s.tc; for (var i = 0; i < 6 && n && n !== document.body; i++) { var r = n.getBoundingClientRect(); if (r.width > sW * 0.4 && r.top > bandTop) return n; n = n.parentElement; } return s.tc; }
    if (s.bar) { var p = s.bar.parentElement; if (p) { var pr = p.getBoundingClientRect(); if (pr.top > bandTop && pr.width > sW * 0.4) return p; } return s.bar; }
    return null;
  }
  var s = scan();
  if (mode === 'hide') {
    if (!document.getElementById('__fc_ov_style')) {
      var st = document.createElement('style'); st.id = '__fc_ov_style';
      st.textContent = '[data-fc-ov-hide]{display:none!important;visibility:hidden!important;opacity:0!important;pointer-events:none!important}';
      (document.head || document.documentElement).appendChild(st);
    }
    var mark = function () { var ss = scan(); [chromeOf(ss), ss.bar, ss.play, ss.tc].forEach(function (el) { if (el && el.setAttribute) el.setAttribute('data-fc-ov-hide', '1'); }); };
    mark();
    if (!window.__fc_ov_obs) { try { window.__fc_ov_obs = new MutationObserver(function () { mark(); }); window.__fc_ov_obs.observe(document.body, { childList: true, subtree: true }); } catch (e) {} }
    return { hidden: true };
  }
  var ev = []; if (s.tc) ev.push('timecode'); if (s.bar) ev.push('progress-bar'); if (s.play) ev.push('play-glyph');
  var ch = chromeOf(s); var y = 0.9;
  var rr = ch ? ch.getBoundingClientRect() : (s.bar ? s.bar.getBoundingClientRect() : null);
  if (rr && sH > 0) y = Math.max(0, Math.min(1, (rr.top - S.top) / sH));
  var detected = false, conf = 0;
  if (s.tc) { detected = true; conf = 0.9; } else if (s.bar && s.play) { detected = true; conf = 0.7; } else if (s.bar) { detected = false; conf = 0.4; }
  return { detected: detected, confidence: conf, removable: !!ch, kind: 'dom', y: Math.round(y * 1000) / 1000, evidence: ev, box: { x: 0, y: Math.round(y * 1000) / 1000, w: 1, h: Math.round((1 - y) * 1000) / 1000 } };
}

// ----------------------------------------------------------------------------
// Network egress guard (pure classifier) — used by render.js page.route to keep a
// malicious uploaded animation from reaching internal/cloud-metadata/localhost
// addresses (SSRF). Public hosts are allowed so real artifacts can load CDNs.
// ----------------------------------------------------------------------------

// Is this resolved IP literal in a private / loopback / link-local / CGNAT range?
function isPrivateIp(ip) {
  if (!ip) return false;
  if (net.isIPv4(ip)) {
    const p = ip.split('.').map(Number);
    if (p[0] === 0 || p[0] === 10 || p[0] === 127) return true;          // this-host, private, loopback
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;          // private
    if (p[0] === 192 && p[1] === 168) return true;                      // private
    if (p[0] === 169 && p[1] === 254) return true;                      // link-local + cloud metadata
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true;         // CGNAT
    return false;
  }
  const s = String(ip).toLowerCase();
  if (s === '::1' || s === '::') return true;                           // loopback / unspecified
  if (s.startsWith('fe80') || s.startsWith('fc') || s.startsWith('fd')) return true; // link-local / ULA
  if (s.startsWith('::ffff:')) { const v4 = s.split(':').pop(); if (net.isIPv4(v4)) return isPrivateIp(v4); }
  return false;
}

// Decide what to do with a sub-request URL from the rendered page:
//   'allow'   -> let it through (the document itself, data:/blob:, public hosts)
//   'block'   -> abort (file: subresources, localhost/metadata/.internal, private IPs)
//   'resolve' -> a public-looking hostname; caller must DNS-resolve and re-check
function classifyEgress(url, target) {
  if (!url) return 'block';
  if (url === target || url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('about:')) return 'allow';
  let u; try { u = new URL(url); } catch (e) { return 'block'; }
  if (u.protocol === 'file:') return 'block';                          // no reading other local files
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'block';
  let host = u.hostname; if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (/^(localhost|metadata\.google\.internal)$/i.test(host)) return 'block';
  if (/\.(internal|local|localdomain)$/i.test(host)) return 'block';
  if (net.isIP(host)) return isPrivateIp(host) ? 'block' : 'allow';
  return 'resolve';
}

module.exports = {
  aHashFromGray, hamming, popcount, rgbaTo8x8Gray, frameSignature,
  findLoopPeriod, detectBlankRanges, median, scoreOverlay, overlayPageFn,
  isPrivateIp, classifyEgress,
  LOOP_DEFAULTS, BLANK_DEFAULTS,
};
