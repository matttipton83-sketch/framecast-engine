// render.js — Framecast core engine
// Deterministic HTML-animation -> video renderer.
//
//   const { render } = require('./render');
//   await render({ input: 'anim.html', preset: 'youtube-1080', durationSec: 12 });
//
// Pipeline: Chromium (Playwright) renders frame-by-frame on a virtual clock,
// each frame is screenshotted as raw PNG and piped straight into ffmpeg —
// no temp files, no dropped frames, no stutter.

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { PRESETS, QUALITY } = require('./presets');
const dns = require('dns').promises;
const { findLoopPeriod, detectBlankRanges, frameSignature, overlayPageFn, classifyEgress, isPrivateIp } = require('./analyze');
const virtualTimeScript = require('./virtual-time');

const HARD_CAP_SEC = 75; // product ceiling: 1:15
const MAX_JOB_MS = Number(process.env.FRAMECAST_MAX_JOB_MS || 240000); // hard kill: a single job can't run longer than this

// SSRF guard: block the rendered (untrusted) page from reaching internal /
// cloud-metadata / localhost / private-network addresses. Public hosts are
// allowed so legitimate artifacts can still load their CDNs/fonts. file:
// subresources are blocked so a page can't read other local files.
function installNetGuard(page, target) {
  return page.route('**/*', async (route) => {
    try {
      const url = route.request().url();
      const verdict = classifyEgress(url, target);
      if (verdict === 'allow') return route.continue();
      if (verdict === 'block') return route.abort();
      // 'resolve': public-looking hostname — DNS-resolve and block if it maps to a private IP
      try {
        const addrs = await dns.lookup(new URL(url).hostname, { all: true });
        if (addrs.some((a) => isPrivateIp(a.address))) return route.abort();
      } catch (e) { /* DNS error -> fail open (literal-IP + metadata cases already blocked) */ }
      return route.continue();
    } catch (e) { try { return route.continue(); } catch (_) {} }
  });
}

// Recursively find the first .ttf/.otf under a directory (last-resort fallback).
function scanForFont(dir, depth = 0) {
  if (depth > 4) return null;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return null; }
  for (const e of entries) {
    const p = dir + '/' + e.name;
    if (e.isDirectory()) { const r = scanForFont(p, depth + 1); if (r) return r; }
    else if (/\.(ttf|otf)$/i.test(e.name)) return p;
  }
  return null;
}

// Find a usable font for the watermark. Tries known paths, then scans the system
// font dirs so it works on any image (Render's Playwright image ships Liberation/Noto,
// not DejaVu at the old path — which is why the watermark was silently skipped).
function findFont() {
  const candidates = [
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
    '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
    '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
    '/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
    '/System/Library/Fonts/Helvetica.ttc',
  ];
  for (const f of candidates) { try { if (fs.statSync(f).isFile()) return f; } catch (_) {} }
  return scanForFont('/usr/share/fonts') || scanForFont('/usr/local/share/fonts');
}

// Free-tier watermark: a faint centered brand mark (deters cropping) plus a
// small corner badge. Removed entirely for paid exports.
function watermarkFilter() {
  const font = findFont();
  if (!font) return null; // no font -> render without watermark rather than fail
  const ff = font.replace(/:/g, '\\:').replace(/ /g, '\\ ');
  const center = `drawtext=fontfile='${ff}':text='FRAMECAST':fontcolor=white@0.34:fontsize=(h/8):x=(w-text_w)/2:y=(h-text_h)/2:shadowcolor=black@0.35:shadowx=2:shadowy=2`;
  const badge = `drawtext=fontfile='${ff}':text='Made with Framecast':fontcolor=white@0.92:fontsize=(h/34):box=1:boxcolor=black@0.55:boxborderw=12:x=w-text_w-28:y=h-text_h-28`;
  return `${center},${badge}`;
}

function buildFfmpegArgs({ container, fps, width, height, quality, transparent, watermark, outPath }) {
  const q = QUALITY[quality] || QUALITY.high;
  const common = ['-y', '-f', 'image2pipe', '-framerate', String(fps), '-i', 'pipe:0'];
  const wm = watermark ? watermarkFilter() : null;
  const base = `scale=${width}:${height}:flags=lanczos` + (wm ? `,${wm}` : '');

  if (container === 'mp4') {
    return [
      ...common,
      '-vf', base,
      '-c:v', 'libx264', '-preset', q.preset, '-crf', String(q.crf),
      '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
      outPath,
    ];
  }
  if (container === 'webm') {
    // VP9 with alpha for transparent overlays
    const pix = transparent ? 'yuva420p' : 'yuv420p';
    return [
      ...common,
      '-vf', base,
      '-c:v', 'libvpx-vp9', '-pix_fmt', pix, '-b:v', '0', '-crf', String(q.crf + 8),
      '-row-mt', '1',
      outPath,
    ];
  }
  if (container === 'gif') {
    // single-stream palette generation for clean colors
    return [
      ...common,
      '-vf', `${base},split[s0][s1];[s0]palettegen=stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3`,
      outPath,
    ];
  }
  throw new Error('Unknown container: ' + container);
}

// Decide the end index of an animation from a sequence of per-frame "signatures"
// (here, JPEG byte sizes). Pure + testable. Returns the step index of the last
// real change, or -1 if nothing ever changed meaningfully.
// A real visual change shifts the JPEG size by well over this; an identical
// (held) frame re-encodes to ~the same size. Kept small + mostly absolute so we
// bias toward DETECTING change (over-capturing is safe; truncating is not).
function isFrameChange(a, b) {
  return Math.abs(a - b) > Math.max(120, b * 0.0015);
}

function lastChangeIndex(sizes) {
  let last = -1;
  for (let i = 1; i < sizes.length; i++) {
    if (isFrameChange(sizes[i], sizes[i - 1])) last = i;
  }
  return last;
}

// Turn a sequence of frame signatures into a duration in seconds.
// Returns 0 when nothing changed (caller falls back to its default).
function settleDurationSec(sizes, stepMs, { capSec = 75, minSec = 3 } = {}) {
  const li = lastChangeIndex(sizes);
  if (li < 0) return 0;
  return Math.min(capSec, Math.max(minSec, (li * stepMs) / 1000 + 0.5));
}

// Probe the page once and derive everything we can from a single tiny-viewport
// scan: the settle duration (when motion stops) AND a perceptual fingerprint per
// frame for loop / blank detection. Used only when no readable timeline
// (CSS/WAAPI/GSAP global) was found. Falls back gracefully on any failure.
//
// Window note: to recognize a LOOP we must observe ~2 full cycles, so the scan
// runs to `loopWindowSec` (default 150s) — longer than the 75s product cap — even
// though the rendered clip is still capped at capSec. This only runs on the hard
// "no timeline" path, so the extra tiny screenshots are a fair price for not
// rendering a 60s looping ad out to 75s.
// Pick the animation's TRUE aspect ratio. The naive "largest element" heuristic is
// fooled by full-bleed letterbox/pillarbox wrappers — a 9:16 film centered inside a
// black `inset:0` div measures as 16:9. So: if a viewport-filling element with a
// SOLID (opaque) background exists (= letterbox bars) AND there's a large inset
// element spanning exactly one axis (the real stage), use the stage's aspect.
// Otherwise fall back to the largest element (genuine full-bleed) — prior behavior.
function stageAspectInPage() {
  // Highest-confidence signal: an explicit stage element (the convention in our
  // own ads and most Claude artifacts). Its own box IS the authored canvas, so it
  // isn't fooled by a GRADIENT or otherwise non-solid full-bleed backdrop the way
  // the letterbox heuristic below can be (that path only recognizes solid-color
  // bars, so a gradient backdrop makes it fall back to the viewport aspect and a
  // 1:1 / 9:16 stage gets mis-read as 16:9). Trust it ONLY when its aspect snaps to
  // a standard target, so a mislabeled or partial #stage can never hijack
  // detection — otherwise fall through to the heuristic below unchanged.
  try {
    const ex = document.querySelector('#stage, [data-framecast-stage]');
    if (ex) {
      const er = ex.getBoundingClientRect();
      if (er.width > 40 && er.height > 40) {
        const ear = er.width / er.height;
        if ([16 / 9, 1, 9 / 16].some((t) => Math.abs(ear - t) <= t * 0.06)) return ear;
      }
    }
  } catch (e) {}
  const vw = window.innerWidth, vh = window.innerHeight, vArea = vw * vh;
  const near = (a, b) => Math.abs(a - b) <= b * 0.03;
  const els = document.body ? document.body.querySelectorAll('*') : [];
  let fill = { area: 0, w: 16, h: 9 }, stage = { area: 0, w: 0, h: 0 }, hasLetterbox = false;
  for (const el of els) {
    const r = el.getBoundingClientRect();
    if (r.width < 40 || r.height < 40) continue;
    const area = r.width * r.height;
    const fillsW = near(r.width, vw), fillsH = near(r.height, vh);
    if (fillsW && fillsH) {
      if (area > fill.area) fill = { area, w: r.width, h: r.height };
      try {
        const bg = getComputedStyle(el).backgroundColor;
        const m = bg && bg.match(/^rgba?\(([^)]+)\)/);
        if (m) { const p = m[1].split(',').map((s) => parseFloat(s)); const a = p.length >= 4 ? p[3] : 1; if (a > 0.1) hasLetterbox = true; }
      } catch (e) {}
    } else if ((fillsW || fillsH) && r.width <= vw * 1.02 && r.height <= vh * 1.02 && area > stage.area && area > vArea * 0.2) {
      stage = { area, w: r.width, h: r.height };
    }
  }
  // Only trust the inset stage if its aspect is close to a standard target —
  // real letterboxed exports target 16:9 / 1:1 / 9:16; an incidental inset block
  // (e.g. a tall hero in a full-bleed 16:9 design) won't, so we keep the fill.
  const stageAr = stage.area ? stage.w / stage.h : 0;
  const snapsToStandard = [16 / 9, 1, 9 / 16].some((t) => Math.abs(stageAr - t) <= t * 0.06);
  let pick;
  if (hasLetterbox && stage.area > 0 && snapsToStandard) pick = stage;
  else if (fill.area > 0) pick = fill;
  else { const de = document.documentElement; pick = { w: de.scrollWidth || 16, h: de.scrollHeight || 9 }; }
  return pick.w / pick.h;
}

async function analyzeProbe(page, { capSec = 75, loopWindowSec = 150, stepMs = 500, minSec = 3, aspect = 0 } = {}) {
  const empty = { settleSec: 0, loop: { detected: false }, blanks: { blankRanges: [], tornSteps: [] } };
  try {
    const prevW = page.viewportSize();
    // Size the tiny probe to the CONTENT aspect so a letterboxed clip fills the probe
    // frame; otherwise the bars dominate the per-frame signature and the loop/settle
    // detectors misfire (a 9:16 clip probed at 16:9 reads as a false short loop).
    let ar = aspect || (prevW && prevW.height ? prevW.width / prevW.height : 16 / 9);
    if (!isFinite(ar) || ar <= 0) ar = 16 / 9;
    const pw = ar >= 1 ? Math.max(2, Math.round((180 * ar) / 2) * 2) : 180;
    const ph = ar >= 1 ? 180 : Math.max(2, Math.round((180 / ar) / 2) * 2);
    await page.setViewportSize({ width: pw, height: ph }); // tiny = fast probe, aspect-matched
    const steps = Math.floor((loopWindowSec * 1000) / stepMs);
    const signatures = [];
    // Scan the FULL window (no early break): a mid-clip pause must never be
    // mistaken for the end, and a long loop period needs the whole window.
    for (let i = 0; i <= steps; i++) {
      await page.evaluate((tt) => { window.__framecast.tick(tt); window.__framecast.seekDeclarative(tt); }, i * stepMs);
      const buf = await page.screenshot({ type: 'jpeg', quality: 50 });
      signatures.push(frameSignature(buf)); // { size, hash }
    }
    if (prevW) await page.setViewportSize(prevW);
    const sizes = signatures.map((s) => s.size);
    return {
      settleSec: settleDurationSec(sizes, stepMs, { capSec, minSec }),
      loop: findLoopPeriod(signatures, stepMs),
      blanks: detectBlankRanges(signatures, stepMs),
    };
  } catch (e) {
    return empty; // any failure -> caller default
  }
}

// Wait for the REAL animation to be mounted and settled before we capture frame 0.
// Many Claude artifacts are "bundled": they show a placeholder, then async-load
// React/Babel and mount the actual animation at runtime. Capturing before that
// finishes means the opening is missed ("starts late / cut off"). Driven entirely
// from Node, because the page's own setTimeout/Date are virtualized (frozen at 0).
async function waitForReady(page, maxMs = 12000) {
  const deadline = Date.now() + maxMs;
  // a) Known Claude bundler placeholder(s) gone -> the real component has mounted.
  await page.waitForFunction(() => {
    const ids = ['__bundler_thumbnail', '__bundler_loading', '__bundler_placeholder'];
    return ids.every((id) => {
      const el = document.getElementById(id);
      if (!el) return true;
      const cs = getComputedStyle(el);
      return cs.display === 'none' || cs.visibility === 'hidden' || el.offsetHeight === 0;
    });
  }, { timeout: Math.max(500, deadline - Date.now()), polling: 200 }).catch(() => {});
  // b) DOM stops changing -> first real paint is in. Polled from Node (NOT page
  //    timers). Once mounted, the virtual clock is paused at 0 so the DOM is stable.
  let lastSig = null, stableSince = Date.now();
  while (Date.now() < deadline) {
    const sig = await page.evaluate(() => (document.body ? document.body.innerHTML.length : 0)).catch(() => -1);
    if (sig === lastSig) { if (Date.now() - stableSince > 500) break; }
    else { lastSig = sig; stableSince = Date.now(); }
    await page.waitForTimeout(150);
  }
}

async function render(opts) {
  const {
    input,                         // path to .html (or http URL)
    preset = 'youtube-1080',
    quality = 'high',
    outDir,
    onProgress = () => {},
  } = opts;

  const auto = preset === 'auto' || opts.autoFormat;
  let activePreset = auto ? 'youtube-1080' : preset;
  let p = PRESETS[activePreset];
  if (!p) throw new Error('Unknown preset: ' + preset);

  const isUrl = /^https?:\/\//i.test(input);
  const baseName = isUrl ? 'animation' : path.basename(input).replace(/\.[^.]+$/, '');
  const outputDir = outDir || (isUrl ? process.cwd() : path.dirname(input));

  const browser = await chromium.launch({ args: ['--force-color-profile=srgb', '--disable-lcd-text'] });
  const killTimer = setTimeout(() => { try { browser.close(); } catch (_) {} }, MAX_JOB_MS); // hard kill on runaway uploads
  // Probe at a neutral 16:9 viewport first; we'll resize once we know the format.
  const page = await browser.newPage({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
  });

  // Inject the virtual clock before the page's own code runs.
  await page.addInitScript(virtualTimeScript());

  const target = isUrl ? input : 'file://' + path.resolve(input);
  await installNetGuard(page, target); // SSRF guard before any navigation
  // Don't block on slow/blocked external resources (e.g. web fonts). Get the DOM
  // and scripts running fast, then give the page a brief, bounded settle window.
  try {
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 20000 });
  } catch (e) {
    try { await page.goto(target, { waitUntil: 'commit', timeout: 20000 }); } catch (_) {}
  }
  // Cap the font wait so a hanging font request can never stall the render.
  // Race on the Node side — the page's own setTimeout is virtualized and would
  // never fire while the clock is paused at 0.
  await Promise.race([
    page.evaluate(() => (document.fonts && document.fonts.ready) || Promise.resolve()).catch(() => {}),
    page.waitForTimeout(2500),
  ]);
  await page.waitForTimeout(150);
  // Gate on the real animation being mounted (bundled artifacts load async). This
  // is what makes the capture actually start at the animation's beginning, and it
  // also means aspect-detection measures the real content, not a placeholder.
  await waitForReady(page);

  // --- format auto-detection: read the animation's natural aspect ratio ---
  if (auto) {
    const ar = await page.evaluate(stageAspectInPage);
    // map measured aspect ratio to the closest standard preset
    const candidates = [
      { id: 'youtube-1080', r: 16 / 9 },
      { id: 'square-1080', r: 1 },
      { id: 'vertical-1080', r: 9 / 16 },
    ];
    activePreset = candidates.sort((a, b) => Math.abs(a.r - ar) - Math.abs(b.r - ar))[0].id;
    p = PRESETS[activePreset];
  }

  const fps = opts.fps || p.fps;
  let width = opts.width || p.width;
  let height = opts.height || p.height;
  // Free-tier resolution cap: shrink to maxHeight (keeps aspect, even dims).
  // Capturing at the smaller size directly also saves server compute.
  if (opts.maxHeight && height > opts.maxHeight) {
    const scale = opts.maxHeight / height;
    height = opts.maxHeight;
    width = Math.round((width * scale) / 2) * 2;
  }
  const transparent = opts.transparent ?? p.transparent ?? false;
  const watermark = !!opts.watermark;
  const ext = p.container;
  const tag = watermark ? `${activePreset}-preview` : activePreset;
  const outPath = path.join(outputDir, `${baseName}-${tag}.${ext}`);
  await page.setViewportSize({ width, height });
  await page.waitForTimeout(80);

  // Decide duration.
  let durationSec = opts.durationSec;
  let clockDirty = false;
  let analysis = null; // { loop, blanks } from the probe — surfaced on the result
  let durSource = opts.durationSec ? 'requested' : 'default'; // which path set duration
  let durInfo = null;  // readable-timeline diagnostic numbers (for the log + Phase 2)
  if (!durationSec || opts.autoDetect) {
    const info = await page.evaluate(() => {
      // 1) Explicit author intent wins — the reliable path for held end cards.
      //    Add EITHER to your HTML:
      //      <script>window.FRAMECAST_DURATION = 60</script>
      //      <meta name="framecast:duration" content="60">
      let declaredMs = 0;
      try {
        if (typeof window.FRAMECAST_DURATION === 'number' && window.FRAMECAST_DURATION > 0) {
          declaredMs = window.FRAMECAST_DURATION * 1000;
        } else {
          const m = document.querySelector('meta[name="framecast:duration"]');
          const v = m && parseFloat(m.getAttribute('content'));
          if (v > 0) declaredMs = v * 1000;
        }
      } catch (e) {}
      // 2) Readable CSS/WAAPI timelines, and GSAP's global timeline if exposed.
      const css = window.__framecast.longestFiniteMs();
      let gsapMs = 0;
      try {
        const g = window.gsap;
        if (g && g.globalTimeline) {
          const td = g.globalTimeline.totalDuration();
          // An infinitely-repeating GSAP timeline (repeat:-1) reports Infinity or a
          // huge sentinel — that's NOT the animation's real end. Ignore anything
          // non-finite or implausibly long (>10h) so the loop probe can find the
          // true cycle length instead of falling back to the 75s cap.
          if (isFinite(td) && td > 0 && td < 36000) gsapMs = td * 1000;
        }
      } catch (e) {}
      return { declaredMs, cssMs: css.max || 0, gsapMs, max: Math.max(css.max || 0, gsapMs), sawInfinite: css.sawInfinite };
    });
    durInfo = info;
    // Declared duration is authoritative (covers intentional end-card holds).
    if (info.declaredMs > 0) {
      durationSec = Math.min(HARD_CAP_SEC, info.declaredMs / 1000);
      durSource = 'declared';
    } else if (opts.autoDetect && info.max > 0) {
      durationSec = Math.min(HARD_CAP_SEC, Math.ceil((info.max / 1000) + 0.5));
      // Which readable timeline won? (GSAP is ignored when infinite — see above.)
      durSource = (info.gsapMs > 0 && info.gsapMs >= info.cssMs) ? 'gsap' : 'css';
    }
    // No readable timeline (e.g. bundled GSAP)? Probe for motion + loop + blanks.
    if (opts.autoDetect && !durationSec) {
      const probe = await analyzeProbe(page, { capSec: HARD_CAP_SEC, aspect: width / height });
      analysis = { loop: probe.loop, blanks: probe.blanks };
      // A confident LOOP -> render exactly ONE clean cycle instead of running to
      // the 75s cap. This is the fix for looping ads over-detecting to 1:15.
      if (probe.loop && probe.loop.detected && probe.loop.confidence >= 0.6) {
        durationSec = Math.min(HARD_CAP_SEC, Math.max(1, probe.loop.periodSec));
        durSource = 'loop';
      } else if (probe.settleSec > 0) {
        durationSec = probe.settleSec; // motion-settle fallback (previous behavior)
        durSource = 'settle';
      }
      clockDirty = true; // the probe advanced the virtual clock + animation state
    }
  }
  if (!durationSec) durationSec = 15;              // sensible default
  durationSec = Math.min(durationSec, HARD_CAP_SEC); // enforce 1:15 ceiling

  // One diagnostic line per render: which path decided the duration, plus the raw
  // timeline numbers. Makes it visible in Render logs whether 'loop', 'css',
  // 'gsap', etc. won — and feeds the Phase 2 detect-and-confirm card.
  {
    const lp = analysis && analysis.loop;
    const s = (ms) => ((ms || 0) / 1000).toFixed(1) + 's';
    console.log(`[framecast] duration=${durationSec}s source=${durSource}`
      + (durInfo ? ` | declared=${s(durInfo.declaredMs)} css=${s(durInfo.cssMs)} gsap=${s(durInfo.gsapMs)}${durInfo.sawInfinite ? ' css∞' : ''}` : '')
      + (lp ? ` | loop=${lp.detected ? lp.periodSec + 's ×' + lp.cycles + ' conf' + lp.confidence : 'none'}` : ''));
  }

  // The probe ran the animation forward to find its end, leaving JS state (GSAP,
  // canvas) at that time. Reload so the real render starts from a clean t=0.
  if (clockDirty) {
    try {
      await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 20000 });
    } catch (e) {
      try { await page.goto(target, { waitUntil: 'commit', timeout: 20000 }); } catch (_) {}
    }
    await Promise.race([
      page.evaluate(() => (document.fonts && document.fonts.ready) || Promise.resolve()).catch(() => {}),
      page.waitForTimeout(2500),
    ]);
    await waitForReady(page); // re-mount after the reload before the real capture
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(120);
  }

  const totalFrames = Math.round(durationSec * fps);
  const frameMs = 1000 / fps;

  const ffmpegArgs = buildFfmpegArgs({ container: ext, fps, width, height, quality, transparent, watermark, outPath });
  const ffmpegBin = opts.ffmpegPath || process.env.FRAMECAST_FFMPEG || 'ffmpeg';
  const ffmpeg = spawn(ffmpegBin, ffmpegArgs, { stdio: ['pipe', 'inherit', 'inherit'] });
  let ffmpegErr = null;
  ffmpeg.stdin.on('error', (e) => { ffmpegErr = ffmpegErr || e; }); // swallow EPIPE if ffmpeg exits
  const ffmpegDone = new Promise((res, rej) => {
    ffmpeg.on('close', (code) => code === 0 ? res()
      : rej(new Error('ffmpeg exited ' + code + ' (filter/codec issue — e.g. drawtext needs full ffmpeg)')));
    ffmpeg.on('error', rej);
  });
  ffmpegDone.catch(() => {}); // never an "unhandled" rejection (would crash the process)

  // Optional: remove a baked-in play-bar / fake video-player UI before capture.
  //  • DOM bars  -> hide the chrome elements (display:none + MutationObserver so
  //    they stay hidden across re-renders); the animation itself is untouched.
  //  • SVG/canvas/dynamic bars (vision tie-break) -> can't be hidden, so crop the
  //    bottom strip via the capture clip; the existing scale upsizes it back to
  //    full size (uniform zoom, no distortion).
  const cropBottom = (opts.cropBottom && opts.cropBottom > 0.02 && opts.cropBottom < 0.5) ? opts.cropBottom : 0;
  let grabClip = { x: 0, y: 0, width, height };
  if (cropBottom) {
    const cw = Math.max(2, Math.round(width * (1 - cropBottom) / 2) * 2);
    const ch = Math.max(2, Math.round(height * (1 - cropBottom) / 2) * 2);
    grabClip = { x: Math.round((width - cw) / 2), y: 0, width: cw, height: ch };
  } else if (opts.removeOverlay) {
    try { await page.evaluate(overlayPageFn, { mode: 'hide' }); } catch (_) {}
  }

  // Capture via the raw DevTools protocol — skips Playwright's per-screenshot
  // overhead (stability checks, marshalling), a meaningful per-frame win over
  // thousands of frames. Falls back to page.screenshot for transparent output
  // (alpha needs PNG + omitBackground, cleanest through Playwright).
  // Capture each frame as JPEG (visually lossless into x264, ~2x faster than
  // PNG); PNG only for transparent output, which needs alpha. This is the proven
  // Playwright screenshot path — full device-pixel resolution, no surprises.
  function grab() {
    const shot = transparent ? { type: 'png', omitBackground: true } : { type: 'jpeg', quality: 90 };
    return page.screenshot({ ...shot, animations: 'allow', clip: grabClip });
  }

  try {
    // Warm-up: Chrome's compositor goes stale between page-load and the first
    // capture, so the first frames come out blank/half-rendered — that's the
    // "beginning gets cut off" bug. Pin the clock at t=0, force a reflow, and
    // discard a couple of priming frames so frame 0 is the true, settled start.
    await page.evaluate(() => {
      window.__framecast.tick(0);
      window.__framecast.seekDeclarative(0);
      if (document.body) void document.body.offsetHeight;
    });
    try { await grab(); await grab(); } catch (_) {}

    for (let i = 0; i < totalFrames; i++) {
      if (ffmpegErr || !ffmpeg.stdin.writable) throw new Error('ffmpeg stopped early' + (ffmpegErr ? ': ' + ffmpegErr.message : ' (exit ' + ffmpeg.exitCode + ')'));
      const t = i * frameMs;
      // Keep CSS animations seeked to the exact virtual time (animations:'allow'
      // semantics) rather than reset — we set currentTime explicitly.
      await page.evaluate((tt) => {
        window.__framecast.tick(tt);
        window.__framecast.seekDeclarative(tt);
      }, t);
      const frame = await grab();
      const ok = ffmpeg.stdin.write(frame);
      if (!ok) await new Promise((r) => ffmpeg.stdin.once('drain', r));
      if (i % Math.ceil(fps / 2) === 0 || i === totalFrames - 1) {
        onProgress({ frame: i + 1, total: totalFrames, pct: Math.round(((i + 1) / totalFrames) * 100) });
      }
    }
    try { ffmpeg.stdin.end(); } catch (_) {}
    await ffmpegDone;
  } finally {
    clearTimeout(killTimer);
    try { await browser.close(); } catch (_) {}
  }

  const { size } = fs.statSync(outPath);
  return { outPath, durationSec, totalFrames, fps, width, height, bytes: size,
    durSource, durInfo, loop: analysis ? analysis.loop : null, blanks: analysis ? analysis.blanks : null };
}

// run ffmpeg with args, resolve on success.
function runFfmpeg(args, bin) {
  return new Promise((res, rej) => {
    const p = spawn(bin || process.env.FRAMECAST_FFMPEG || 'ffmpeg', args, { stdio: ['ignore', 'inherit', 'inherit'] });
    p.on('close', (c) => c === 0 ? res() : rej(new Error('ffmpeg exited ' + c)));
    p.on('error', rej);
  });
}

// Reframe a MASTER video into a target format. Same aspect = clean scale; a
// different aspect = the master fitted inside, with a blurred-zoomed fill behind
// (no ugly black bars). Optional watermark. This is the "smart reframe".
function reframeArgs({ masterPath, masterW, masterH, width, height, container, quality, watermark, fps, outPath }) {
  const q = QUALITY[quality] || QUALITY.high;
  const wm = watermark ? watermarkFilter() : null;
  const wmS = wm ? `,${wm}` : '';
  // If the target aspect matches the master, there are no bars to fill — just
  // scale. This skips the whole blur/overlay (one of the 3 kit formats always
  // matches the master's native aspect), a big saving.
  const sameAspect = masterW && masterH && Math.abs((masterW / masterH) - (width / height)) < 0.01;
  let fit;
  if (sameAspect) {
    fit = `[0:v]scale=${width}:${height}:flags=lanczos,setsar=1${wmS}`;
  } else {
    // Blurred-zoom fill behind a fitted master. The blur runs on a HALF-RES
    // plane (sigma halved to match) then scales up — visually identical to a
    // full-res sigma=22 blur but ~5-6x cheaper. Done for each non-matching format.
    const bw = Math.max(2, Math.round(width / 4) * 2), bh = Math.max(2, Math.round(height / 4) * 2);
    fit = `[0:v]split[bg][fg];[bg]scale=${bw}:${bh}:force_original_aspect_ratio=increase,crop=${bw}:${bh},gblur=sigma=11,scale=${width}:${height}[bgb];[fg]scale=${width}:${height}:force_original_aspect_ratio=decrease[fgs];[bgb][fgs]overlay=(W-w)/2:(H-h)/2,setsar=1${wmS}`;
  }
  if (container === 'gif') {
    return ['-y', '-i', masterPath, '-filter_complex', `${fit},split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3`, '-r', String(Math.min(fps, 24)), outPath];
  }
  if (container === 'webm') {
    return ['-y', '-i', masterPath, '-filter_complex', fit, '-r', String(fps), '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuv420p', '-b:v', '0', '-crf', String(q.crf + 8), '-row-mt', '1', outPath];
  }
  return ['-y', '-i', masterPath, '-filter_complex', fit, '-r', String(fps), '-c:v', 'libx264', '-preset', q.preset, '-crf', String(q.crf), '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-x264-params', 'threads=0', outPath];
}

// One drop -> every platform. Capture the animation ONCE (the expensive part),
// then reframe that master into each requested format. Returns one file per format.
async function renderKit(opts) {
  const kitPresets = opts.kitPresets || ['youtube-1080', 'vertical-1080', 'square-1080'];
  const onProgress = opts.onProgress || (() => {});
  // 1) master: clean, full-res, native aspect, full duration (the one capture).
  // Encode it near-lossless but FAST ('intermediate'): it's deleted after the
  // reframes, so a slow encode here would be pure waste.
  const master = await render({
    ...opts, preset: opts.preset || 'auto', autoFormat: (opts.preset || 'auto') === 'auto',
    watermark: false, maxHeight: null, quality: 'intermediate',
  });
  const dir = path.dirname(master.outPath);
  const base = path.basename(master.outPath).replace(/\.[^.]+$/, '');
  const formats = [];
  // 2) reframe master -> each format (cheap, no re-capture). Report progress so
  // the UI keeps moving through this phase instead of looking frozen.
  const n = kitPresets.length;
  for (let idx = 0; idx < n; idx++) {
    const id = kitPresets[idx];
    const p = PRESETS[id];
    if (!p) continue;
    onProgress({ frame: master.totalFrames, total: master.totalFrames, pct: 100, phase: 'reframe', step: idx + 1, steps: n });
    let w = p.width, h = p.height;
    if (opts.maxHeight && h > opts.maxHeight) { const s = opts.maxHeight / h; h = opts.maxHeight; w = Math.round((w * s) / 2) * 2; }
    const outPath = path.join(dir, `${base}-kit-${id}.${p.container}`);
    await runFfmpeg(reframeArgs({ masterPath: master.outPath, masterW: master.width, masterH: master.height, width: w, height: h, container: p.container, quality: opts.quality || 'high', watermark: !!opts.watermark, fps: master.fps, outPath }));
    formats.push({ preset: id, label: p.label, outPath, width: w, height: h, container: p.container, bytes: fs.statSync(outPath).size });
  }
  try { fs.unlinkSync(master.outPath); } catch (_) {}
  return { durationSec: master.durationSec, fps: master.fps, formats };
}

// Fast, capture-free analysis pass for the detect-and-confirm UI. Launches the
// page exactly like render() (virtual clock + mount gate) and runs the SAME
// aspect + duration detection — but never captures a frame or touches ffmpeg, so
// it's much cheaper than a render. Returns what the studio needs to pre-fill its
// controls and explain its choices BEFORE the user commits to (pays for) a render.
async function analyze(opts) {
  const input = opts.input;
  const isUrl = /^https?:\/\//i.test(input);
  const target = isUrl ? input : 'file://' + path.resolve(input);
  const browser = await chromium.launch({ args: ['--force-color-profile=srgb', '--disable-lcd-text'] });
  const killTimer = setTimeout(() => { try { browser.close(); } catch (_) {} }, MAX_JOB_MS); // hard kill on runaway uploads
  try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
    await page.addInitScript(virtualTimeScript());
    await installNetGuard(page, target); // SSRF guard before any navigation
    try { await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 20000 }); }
    catch (e) { try { await page.goto(target, { waitUntil: 'commit', timeout: 20000 }); } catch (_) {} }
    await Promise.race([
      page.evaluate(() => (document.fonts && document.fonts.ready) || Promise.resolve()).catch(() => {}),
      page.waitForTimeout(2500),
    ]);
    await page.waitForTimeout(150);
    await waitForReady(page); // mount gate — measure the real animation, not a placeholder

    // --- aspect ratio -> nearest standard preset (same logic as render's auto) ---
    const aspectRatio = await page.evaluate(stageAspectInPage);
    const cands = [{ id: 'youtube-1080', r: 16 / 9 }, { id: 'square-1080', r: 1 }, { id: 'vertical-1080', r: 9 / 16 }];
    const preset = cands.sort((a, b) => Math.abs(a.r - aspectRatio) - Math.abs(b.r - aspectRatio))[0].id;
    const P = PRESETS[preset];

    // --- duration: same precedence as render (declared > css/gsap > loop > settle) ---
    const info = await page.evaluate(() => {
      let declaredMs = 0;
      try {
        if (typeof window.FRAMECAST_DURATION === 'number' && window.FRAMECAST_DURATION > 0) declaredMs = window.FRAMECAST_DURATION * 1000;
        else { const m = document.querySelector('meta[name="framecast:duration"]'); const v = m && parseFloat(m.getAttribute('content')); if (v > 0) declaredMs = v * 1000; }
      } catch (e) {}
      const css = window.__framecast.longestFiniteMs();
      let gsapMs = 0;
      try { const g = window.gsap; if (g && g.globalTimeline) { const td = g.globalTimeline.totalDuration(); if (isFinite(td) && td > 0 && td < 36000) gsapMs = td * 1000; } } catch (e) {}
      return { declaredMs, cssMs: css.max || 0, gsapMs, max: Math.max(css.max || 0, gsapMs), sawInfinite: css.sawInfinite };
    });
    let durationSec = 0, durSource = 'default', loop = { detected: false }, blanks = { blankRanges: [], tornSteps: [] };
    if (info.declaredMs > 0) { durationSec = Math.min(HARD_CAP_SEC, info.declaredMs / 1000); durSource = 'declared'; }
    else if (info.max > 0) { durationSec = Math.min(HARD_CAP_SEC, Math.ceil(info.max / 1000 + 0.5)); durSource = (info.gsapMs > 0 && info.gsapMs >= info.cssMs) ? 'gsap' : 'css'; }
    if (!durationSec) {
      const probe = await analyzeProbe(page, { capSec: HARD_CAP_SEC, aspect: P.width / P.height });
      loop = probe.loop; blanks = probe.blanks;
      if (probe.loop && probe.loop.detected && probe.loop.confidence >= 0.6) { durationSec = Math.min(HARD_CAP_SEC, Math.max(1, probe.loop.periodSec)); durSource = 'loop'; }
      else if (probe.settleSec > 0) { durationSec = probe.settleSec; durSource = 'settle'; }
    }
    if (!durationSec) { durationSec = 15; durSource = 'default'; }
    durationSec = Math.min(durationSec, HARD_CAP_SEC);

    // --- play-bar / video-UI overlay detection (DOM heuristic) ---
    // Detect at MID-playback: the duration probe leaves the clock at the end,
    // where a fake player UI has usually finished/disappeared. Seek to ~40% so the
    // scrubber + timecode ("0:24 / 1:00") are on screen.
    // The duration probe leaves the clock at the END (player UI usually gone) and
    // backward-seeking doesn't restore it. So reload, re-mount, tick FORWARD to
    // mid-playback so the scrubber + timecode are actually on screen — for both the
    // DOM check and the Claude-vision frame.
    let overlay = { detected: false };
    try {
      try { await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 20000 }); }
      catch (e) { try { await page.goto(target, { waitUntil: 'commit', timeout: 20000 }); } catch (_) {} }
      await Promise.race([
        page.evaluate(() => (document.fonts && document.fonts.ready) || Promise.resolve()).catch(() => {}),
        page.waitForTimeout(2000),
      ]);
      await waitForReady(page);
      const midMs = Math.max(1500, Math.min(durationSec * 1000 * 0.4, durationSec * 1000 - 300));
      await page.evaluate((tt) => { try { window.__framecast.tick(tt); window.__framecast.seekDeclarative(tt); } catch (e) {} }, midMs);
      await page.waitForTimeout(60);
      overlay = await page.evaluate(overlayPageFn, { mode: 'detect' });
      if (!overlay.detected) {
        const frame = await page.screenshot({ type: 'jpeg', quality: 70 });
        const v = (await visionDetectOverlay(frame)) || {};
        overlay.vision = { status: v.status, conf: v.confidence }; // lightweight ops signal
        if (v.present && v.confidence >= 0.5) {
          const yy = +(+v.yFraction).toFixed(3);
          overlay = { detected: true, confidence: v.confidence, kind: 'vision', removable: false, y: yy, evidence: ['vision'], box: { x: 0, y: yy, w: 1, h: +(1 - yy).toFixed(3) }, vision: { status: v.status, conf: v.confidence } };
        }
      }
    } catch (e) { overlay.vision = { status: 'exception' }; }

    return { preset, label: P.label, width: P.width, height: P.height, aspectRatio: +aspectRatio.toFixed(4), durationSec, durSource, loop, blanks, overlay, info };
  } finally {
    clearTimeout(killTimer);
    try { await browser.close(); } catch (_) {}
  }
}

// Vision tie-break: when the DOM heuristic finds no play-bar, ask Claude (Haiku)
// to look at one mid-playback frame. Catches bars drawn in SVG/canvas or built
// dynamically (no clean DOM text to key on) — e.g. the LazzoLead ad. Gated by
// ANTHROPIC_API_KEY: no key => skipped (returns null), so it costs nothing until
// enabled, and Matt controls cost by adding/removing the key on Render.
const VISION_PROMPT =
  'This is ONE frame of an animation that will be exported as a video. Some ads bake a FAKE ' +
  'video-player UI into the design — a play/pause button, a horizontal scrubber/progress bar, and a ' +
  'timecode like "0:19 / 1:00" — usually as a strip near the BOTTOM. It is NOT a real video player, ' +
  'just part of the artwork the user may want removed. Look ONLY for that kind of fake player strip ' +
  '(ignore normal ad text, logos, captions, buttons). Reply with COMPACT JSON only: ' +
  '{"present":true|false,"yFraction":<top edge of the bar as a 0-1 fraction of height>,"confidence":<0-1>}. ' +
  'If there is no such player strip, {"present":false,"yFraction":0,"confidence":0}.';

async function visionDetectOverlay(jpegBuffer) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { present: false, status: 'no-key' };
  if (!jpegBuffer || !jpegBuffer.length) return { present: false, status: 'no-frame' };
  try {
    const body = {
      model: process.env.FRAMECAST_VISION_MODEL || 'claude-haiku-4-5-20251001',
      max_tokens: 120,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: jpegBuffer.toString('base64') } },
        { type: 'text', text: VISION_PROMPT },
      ] }],
    };
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 15000);
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: ctrl.signal,
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).finally(() => clearTimeout(to));
    if (!r.ok) { const t = await r.text().catch(() => ''); return { present: false, status: 'http-' + r.status, note: String(t).slice(0, 160) }; }
    const j = await r.json();
    const txt = (j.content && j.content[0] && j.content[0].text) || '';
    const m = txt.match(/\{[\s\S]*\}/);
    if (!m) return { present: false, status: 'parse-fail', note: txt.slice(0, 160) };
    const o = JSON.parse(m[0]);
    return { present: !!o.present, yFraction: Math.max(0, Math.min(1, +o.yFraction || 0.9)), confidence: Math.max(0, Math.min(1, +o.confidence || 0)), status: 'ok', note: txt.slice(0, 100) };
  } catch (e) { return { present: false, status: 'error', note: String((e && e.message) || e).slice(0, 160) }; }
}

module.exports = { render, renderKit, analyze, visionDetectOverlay, PRESETS, QUALITY, HARD_CAP_SEC, lastChangeIndex, settleDurationSec };
