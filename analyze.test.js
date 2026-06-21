// analyze.test.js — unit tests for the pure analysis logic.
// Run: node analyze.test.js   (no browser, no ffmpeg, no deps)

const A = require('./analyze');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  -> ' + extra : '')); }
}
function eq(name, got, want) { ok(name, got === want, `got ${got}, want ${want}`); }

// ---- helpers to synthesize hashes with controlled distances ----
// A contiguous "window" of `span` set bits starting at `start` (wraps at 64).
function windowHash(start, span = 18) {
  let h = 0n;
  for (let i = 0; i < span; i++) h |= (1n << BigInt(((start % 64) + i) % 64));
  return h;
}
// One distinct frame per phase in [0,P): a window that marches across the field.
// Spreads P phases across the 64-bit field so it works for any period size.
function loopFrame(phase, P) { return windowHash(Math.round((phase / P) * 64), 18); }
const sig = (hash, size = 1000) => ({ size, hash });
function loopSig(P, total) { const s = []; for (let k = 0; k < total; k++) s.push(sig(loopFrame(k % P, P))); return s; }

console.log('\naHashFromGray / hamming / popcount');
{
  const flat = new Array(64).fill(120);
  eq('flat grid -> all 64 bits set', A.popcount(A.aHashFromGray(flat)), 64);
  const half = new Array(64).fill(0).map((_, i) => (i < 32 ? 0 : 255));
  eq('half-dark/half-bright -> 32 bits', A.popcount(A.aHashFromGray(half)), 32);
  eq('hamming(x,x)=0', A.hamming(0b1011n, 0b1011n), 0);
  eq('hamming differs by 2', A.hamming(0b1011n, 0b0001n), 2);
}

console.log('\nrgbaTo8x8Gray');
{
  const w = 16, h = 16, rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) { rgba[i*4]=128; rgba[i*4+1]=128; rgba[i*4+2]=128; rgba[i*4+3]=255; }
  const g = A.rgbaTo8x8Gray(rgba, w, h);
  ok('downsample length 64', g.length === 64);
  ok('solid gray ~128', Math.abs(g[0] - 128) < 1 && Math.abs(g[63] - 128) < 1, g[0]);
}

console.log('\nfindLoopPeriod — positives');
{
  const r = A.findLoopPeriod(loopSig(6, 24), 500);
  ok('clean 6-step loop detected', r.detected && r.periodSteps === 6, JSON.stringify(r));
  ok('confidence high (>0.7)', r.confidence > 0.7, r.confidence);
  // the LazzoLead case: ~60s loop (120 steps) inside the 150s/300-frame window
  const big = A.findLoopPeriod(loopSig(120, 300), 500);
  ok('60s-style loop (120 steps) detected', big.detected && big.periodSteps >= 110, JSON.stringify(big));
  const mid = A.findLoopPeriod(loopSig(60, 300), 500);
  ok('30s loop (60 steps) detected', mid.detected && mid.periodSteps >= 55, JSON.stringify(mid));
}

console.log('\nfindLoopPeriod — negatives (must NOT detect)');
{
  // monotonic progress bar filling: never repeats
  const sigs = [];
  for (let k = 0; k < 20; k++) {
    let h = 0n; for (let b = 0; b < (k + 1) * 3 && b < 64; b++) h |= (1n << BigInt(b));
    sigs.push(sig(h));
  }
  ok('monotonic fill -> no loop', !A.findLoopPeriod(sigs, 500).detected);

  const statics = new Array(20).fill(0).map(() => sig(windowHash(0, 18)));
  ok('static image -> no loop', !A.findLoopPeriod(statics, 500).detected);

  // play once then HOLD on an end card (motion, then frozen tail)
  const held = [];
  for (let p = 0; p < 16; p++) held.push(sig(loopFrame(p, 16)));
  for (let k = 0; k < 40; k++) held.push(sig(loopFrame(15, 16)));
  ok('play-then-hold -> no loop (end card)', !A.findLoopPeriod(held, 500).detected,
     JSON.stringify(A.findLoopPeriod(held, 500)));
}

console.log('\ndetectBlankRanges');
{
  const sigs = [ sig(0n, 30), sig(0n, 25) ];           // 2 blank opening frames
  for (let p = 0; p < 10; p++) sigs.push(sig(loopFrame(p, 10), 1000));
  const r = A.detectBlankRanges(sigs, 500);
  ok('one blank range found', r.blankRanges.length === 1, JSON.stringify(r.blankRanges));
  ok('blank range starts at 0s', r.blankRanges[0] && r.blankRanges[0][0] === 0, JSON.stringify(r.blankRanges));
  ok('blank range ends ~1.0s', r.blankRanges[0] && r.blankRanges[0][1] === 1.0, JSON.stringify(r.blankRanges));

  const t = [ sig(windowHash(0, 18)), sig(windowHash(32, 18)), sig(windowHash(0, 18)) ];
  ok('torn frame detected at step 1', A.detectBlankRanges(t, 500).tornSteps.includes(1));

  const clean = [];
  for (let p = 0; p < 12; p++) clean.push(sig(loopFrame(p, 12), 1000));
  ok('clean clip -> no blank ranges', A.detectBlankRanges(clean, 500).blankRanges.length === 0);
}

console.log('\nscoreOverlay');
{
  const tc=A.scoreOverlay({timecode:0.9,bar:0.9,play:true});
  ok('timecode -> detected, conf .9', tc.detected && tc.confidence===0.9, JSON.stringify(tc));
  const bp=A.scoreOverlay({bar:0.92,play:true});
  ok('bar+play -> detected, conf .7', bp.detected && bp.confidence===0.7, JSON.stringify(bp));
  const b=A.scoreOverlay({bar:0.92});
  ok('lone bar -> NOT detected (too weak)', !b.detected && b.confidence===0.4, JSON.stringify(b));
  const none=A.scoreOverlay({});
  ok('nothing -> not detected', !none.detected && none.evidence.length===0, JSON.stringify(none));
  ok('overlayPageFn is a function (serializable)', typeof A.overlayPageFn==='function');
}

console.log('\nisPrivateIp / classifyEgress (SSRF guard)');
{
  ok('10.x private', A.isPrivateIp('10.1.2.3'));
  ok('127.0.0.1 private', A.isPrivateIp('127.0.0.1'));
  ok('169.254.169.254 (metadata) private', A.isPrivateIp('169.254.169.254'));
  ok('172.16.x private', A.isPrivateIp('172.16.0.1'));
  ok('192.168.x private', A.isPrivateIp('192.168.1.1'));
  ok('8.8.8.8 public', !A.isPrivateIp('8.8.8.8'));
  ok('::1 private', A.isPrivateIp('::1'));

  const T='file:///app/in-x.html';
  eq('document itself -> allow', A.classifyEgress(T, T), 'allow');
  eq('data: -> allow', A.classifyEgress('data:image/png;base64,AAA', T), 'allow');
  eq('file: subresource -> block', A.classifyEgress('file:///etc/passwd', T), 'block');
  eq('localhost -> block', A.classifyEgress('http://localhost:10000/x', T), 'block');
  eq('metadata IP -> block', A.classifyEgress('http://169.254.169.254/latest/', T), 'block');
  eq('private IP -> block', A.classifyEgress('http://10.0.0.5/x', T), 'block');
  eq('.internal host -> block', A.classifyEgress('https://db.internal/x', T), 'block');
  eq('public CDN -> resolve', A.classifyEgress('https://cdnjs.cloudflare.com/x.js', T), 'resolve');
  eq('public IP -> allow', A.classifyEgress('http://8.8.8.8/x', T), 'allow');
  eq('ftp scheme -> block', A.classifyEgress('ftp://x/y', T), 'block');
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
