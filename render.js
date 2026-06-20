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
const virtualTimeScript = require('./virtual-time');

const HARD_CAP_SEC = 75;          // product ceiling: 1:15
// When an animation has NO readable timeline and just keeps moving forever
// (loops / continuous motion), there's no natural end — capturing the full 75s
// is slow and almost never what the user wanted. Default such clips to a short,
// shareable length; the user can always drag the Length slider up to 1:15.
const CONTINUOUS_DEFAULT_SEC = 20;

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

// Probe the page to find when the animation stops changing (its true end).
// Used only when no readable timeline (CSS/WAAPI/GSAP global) was found.
// Bounded by capSec; falls back gracefully (returns 0 => caller uses default).
async function detectDurationSec(page, { capSec = 75, stepMs = 500, minSec = 3 } = {}) {
  try {
    const prevW = page.viewportSize();
    await page.setViewportSize({ width: 480, height: 270 }); // tiny = fast probe
    const steps = Math.floor((capSec * 1000) / stepMs);
    const sizes = [];
    // Scan the FULL window (no early break): a mid-clip pause must never be
    // mistaken for the end. settleDurationSec takes the last real change.
    for (let i = 0; i <= steps; i++) {
      await page.evaluate((tt) => { window.__framecast.tick(tt); window.__framecast.seekDeclarative(tt); }, i * stepMs);
      const buf = await page.screenshot({ type: 'jpeg', quality: 50 });
      sizes.push(buf.length);
    }
    if (prevW) await page.setViewportSize(prevW);
    return settleDurationSec(sizes, stepMs, { capSec, minSec });
  } catch (e) {
    return 0; // any failure -> caller default
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
  // Probe at a neutral 16:9 viewport first; we'll resize once we know the format.
  const page = await browser.newPage({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
  });

  // Inject the virtual clock before the page's own code runs.
  await page.addInitScript(virtualTimeScript());

  const target = isUrl ? input : 'file://' + path.resolve(input);
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

  // --- format auto-detection: read the animation's natural aspect ratio ---
  if (auto) {
    const ar = await page.evaluate(() => {
      // Prefer the largest visible block-ish element as the "stage".
      let best = { area: 0, w: 16, h: 9 };
      const els = document.body ? document.body.querySelectorAll('*') : [];
      for (const el of els) {
        const r = el.getBoundingClientRect();
        const area = r.width * r.height;
        if (r.width > 40 && r.height > 40 && area > best.area) best = { area, w: r.width, h: r.height };
      }
      const de = document.documentElement;
      if (best.area === 0) { best = { w: de.scrollWidth || 16, h: de.scrollHeight || 9 }; }
      return best.w / best.h;
    });
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
        if (g && g.globalTimeline) gsapMs = (g.globalTimeline.totalDuration() || 0) * 1000;
      } catch (e) {}
      return { declaredMs, max: Math.max(css.max || 0, gsapMs), sawInfinite: css.sawInfinite };
    });
    // Declared duration is authoritative (covers intentional end-card holds).
    if (info.declaredMs > 0) {
      durationSec = Math.min(HARD_CAP_SEC, info.declaredMs / 1000);
    } else if (opts.autoDetect && info.max > 0) {
      durationSec = Math.min(HARD_CAP_SEC, Math.ceil((info.max / 1000) + 0.5));
    }
    // No readable timeline (e.g. bundled GSAP)? Probe for when motion stops.
    if (opts.autoDetect && !durationSec) {
      const probed = await detectDurationSec(page, { capSec: HARD_CAP_SEC });
      // If motion runs all the way to the cap, it never settled -> treat as
      // endless and use the short default instead of a full 75s capture.
      if (probed > 0) durationSec = probed >= HARD_CAP_SEC - 1.5 ? CONTINUOUS_DEFAULT_SEC : probed;
      clockDirty = true; // the probe advanced the virtual clock + animation state
    }
  }
  if (!durationSec) durationSec = 15;              // sensible default
  durationSec = Math.min(durationSec, HARD_CAP_SEC); // enforce 1:15 ceiling

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

  // Capture via the raw DevTools protocol — skips Playwright's per-screenshot
  // overhead (stability checks, marshalling), a meaningful per-frame win over
  // thousands of frames. Falls back to page.screenshot for transparent output
  // (alpha needs PNG + omitBackground, cleanest through Playwright).
  let cdp = null;
  if (!transparent) { try { cdp = await page.context().newCDPSession(page); } catch (_) { cdp = null; } }
  const clip = { x: 0, y: 0, width, height, scale: 1 };
  async function grab() {
    if (cdp) {
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 90, clip, captureBeyondViewport: false });
      return Buffer.from(data, 'base64');
    }
    const shot = transparent ? { type: 'png', omitBackground: true } : { type: 'jpeg', quality: 90 };
    return page.screenshot({ ...shot, animations: 'allow', clip: { x: 0, y: 0, width, height } });
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
    try { await browser.close(); } catch (_) {}
  }

  const { size } = fs.statSync(outPath);
  return { outPath, durationSec, totalFrames, fps, width, height, bytes: size };
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

module.exports = { render, renderKit, PRESETS, QUALITY, HARD_CAP_SEC, lastChangeIndex, settleDurationSec };
