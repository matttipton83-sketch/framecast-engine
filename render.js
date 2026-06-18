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

const HARD_CAP_SEC = 75; // product ceiling: 1:15

// Find a usable bold font for the watermark; returns null if none (watermark skipped).
function findFont() {
  const candidates = [
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
    '/System/Library/Fonts/Helvetica.ttc',
    '/usr/share/fonts/TTF/DejaVuSans-Bold.ttf',
  ];
  for (const f of candidates) { try { if (fs.statSync(f).isFile()) return f; } catch (_) {} }
  return null;
}

// Free-tier watermark: a faint centered brand mark (deters cropping) plus a
// small corner badge. Removed entirely for paid exports.
function watermarkFilter() {
  const font = findFont();
  if (!font) return null; // no font -> render without watermark rather than fail
  const ff = font.replace(/:/g, '\\:').replace(/ /g, '\\ ');
  const center = `drawtext=fontfile='${ff}':text='FRAMECAST':fontcolor=white@0.22:fontsize=(h/9):x=(w-text_w)/2:y=(h-text_h)/2`;
  const badge = `drawtext=fontfile='${ff}':text='Made with Framecast':fontcolor=white@0.7:fontsize=(h/40):box=1:boxcolor=black@0.35:boxborderw=10:x=w-text_w-28:y=h-text_h-28`;
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
  if (!durationSec || opts.autoDetect) {
    const info = await page.evaluate(() => {
      const css = window.__framecast.longestFiniteMs();
      // GSAP exposes its own timeline; read its total duration if present.
      let gsapMs = 0;
      try {
        const g = window.gsap;
        if (g && g.globalTimeline) gsapMs = (g.globalTimeline.totalDuration() || 0) * 1000;
      } catch (e) {}
      return { max: Math.max(css.max || 0, gsapMs), sawInfinite: css.sawInfinite };
    });
    if (opts.autoDetect && info.max > 0) {
      durationSec = Math.min(HARD_CAP_SEC, Math.ceil((info.max / 1000) + 0.5));
    }
  }
  if (!durationSec) durationSec = 15;              // sensible default
  durationSec = Math.min(durationSec, HARD_CAP_SEC); // enforce 1:15 ceiling

  const totalFrames = Math.round(durationSec * fps);
  const frameMs = 1000 / fps;

  const ffmpegArgs = buildFfmpegArgs({ container: ext, fps, width, height, quality, transparent, watermark, outPath });
  const ffmpegBin = opts.ffmpegPath || process.env.FRAMECAST_FFMPEG || 'ffmpeg';
  const ffmpeg = spawn(ffmpegBin, ffmpegArgs, { stdio: ['pipe', 'inherit', 'inherit'] });
  const ffmpegDone = new Promise((res, rej) => {
    ffmpeg.on('close', (code) => code === 0 ? res() : rej(new Error('ffmpeg exited ' + code)));
    ffmpeg.on('error', rej);
  });

  for (let i = 0; i < totalFrames; i++) {
    const t = i * frameMs;
    await page.evaluate((tt) => {
      window.__framecast.tick(tt);
      window.__framecast.seekDeclarative(tt);
    }, t);
    const png = await page.screenshot({
      type: 'png',
      omitBackground: transparent,
      // IMPORTANT: keep 'allow'. 'disabled' makes Playwright reset infinite CSS
      // animations to their initial state and fast-forward finite ones, which
      // would clobber the precise currentTime we just seeked. We've already
      // paused every animation, so 'allow' renders the exact frame we want.
      animations: 'allow',
      clip: { x: 0, y: 0, width, height },
    });
    const ok = ffmpeg.stdin.write(png);
    if (!ok) await new Promise((r) => ffmpeg.stdin.once('drain', r));
    if (i % Math.ceil(fps / 2) === 0 || i === totalFrames - 1) {
      onProgress({ frame: i + 1, total: totalFrames, pct: Math.round(((i + 1) / totalFrames) * 100) });
    }
  }

  ffmpeg.stdin.end();
  await ffmpegDone;
  await browser.close();

  const { size } = fs.statSync(outPath);
  return { outPath, durationSec, totalFrames, fps, width, height, bytes: size };
}

module.exports = { render, PRESETS, QUALITY, HARD_CAP_SEC };
