// server.js — Framecast hosted API + UI with PAY-PER-VIDEO.
//
// Flow (this is the whole business model):
//   1) POST /api/jobs         -> renders a FREE preview (watermark + 720p, cheap)
//   2) POST /api/checkout      -> one-time Stripe checkout for THIS video
//   3) POST /api/unlock        -> after payment, renders the CLEAN full-res video
//   4) GET  /api/jobs/:id      -> poll status; GET /files/:id.ext -> download
//
// Rendering runs in a background queue (never in a request). The free preview is
// deliberately cheap so server compute is only spent in full on paying users.
// No subscription wall: a one-time visitor pays once and leaves happy.

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { render, renderKit, analyze } = require('./render');
const { JobQueue } = require('./queue');
const { tierOpts, PRICING } = require('./tiers');
const { createCheckout, verifyPaid, hasActiveSubscription, verifyWebhook, LIVE } = require('./payments');

const PORT = process.env.PORT || 8080;
const PUBLIC = __dirname; // flat layout: index.html sits beside server.js
const WORK = process.env.FRAMECAST_WORK || path.join(os.tmpdir(), 'framecast-cloud');
const CONCURRENCY = Number(process.env.FRAMECAST_CONCURRENCY || 1);
const MAX_HTML_BYTES = Number(process.env.FRAMECAST_MAX_HTML || 8 * 1024 * 1024);
const SOURCE_TTL = 1000 * 60 * 60 * 6; // keep source 6h so a buyer can unlock later
fs.mkdirSync(WORK, { recursive: true });

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.gif': 'image/gif', '.json': 'application/json' };

// Use the full system ffmpeg (has the drawtext filter for watermarks). Only fall
// back to the stripped-down ffmpeg-static if no system ffmpeg is present (e.g.
// some local dev machines) — note that fallback can't draw watermarks.
if (!process.env.FRAMECAST_FFMPEG) {
  try {
    require('child_process').execSync('ffmpeg -version', { stdio: 'ignore' });
    // system ffmpeg available -> render.js defaults to 'ffmpeg'
  } catch (_) {
    try { const f = require('ffmpeg-static'); if (f) process.env.FRAMECAST_FFMPEG = f; } catch (_) {}
  }
}

// A single failed render must NEVER take down the service. Log and keep serving.
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e && e.message ? e.message : e));
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e && e.message ? e.message : e));

// Source params kept so a paid unlock can re-render the SAME clip cleanly.
const sources = new Map();   // jobId -> { params, ts }
const paid = new Map();      // jobId -> true (payment confirmed)
// Cross-subdomain handoff: the landing (framecastvideo.com) can't pass a file to
// the studio (app.framecastvideo.com) via sessionStorage — different origins. So
// the landing stashes the HTML here and the studio fetches it back by id.
const stash = new Map();     // id -> { html, name, ts }
const STASH_TTL = 1000 * 60 * 30; // 30 min is plenty to land + render
setInterval(() => { const now = Date.now(); for (const [k, v] of sources) if (now - v.ts > SOURCE_TTL) sources.delete(k); }, 60000).unref?.();
setInterval(() => { const now = Date.now(); for (const [k, v] of stash) if (now - v.ts > STASH_TTL) stash.delete(k); }, 60000).unref?.();

function runRender(job, onProgress) {
  const { html, name, preset, quality, durationSec, watermark, maxHeight } = job.payload;
  const htmlPath = path.join(WORK, `in-${job.id}.html`);
  fs.writeFileSync(htmlPath, html);
  return render({
    input: htmlPath,
    preset: preset || 'auto',
    autoFormat: (preset || 'auto') === 'auto',
    quality,
    durationSec: durationSec || undefined,
    autoDetect: !durationSec,
    watermark,
    maxHeight,
    removeOverlay: job.payload.removeOverlay,
    cropBottom: job.payload.cropBottom,
    outDir: WORK,
    onProgress,
  }).then((r) => {
    try { fs.unlinkSync(htmlPath); } catch (_) {}
    const ext = path.extname(r.outPath).slice(1);
    const finalName = `${job.id}.${ext}`;
    fs.renameSync(r.outPath, path.join(WORK, finalName));
    return { url: `/files/${finalName}`, bytes: r.bytes, width: r.width, height: r.height, durationSec: r.durationSec, fps: r.fps,
      cleanup: () => { try { fs.unlinkSync(path.join(WORK, finalName)); } catch (_) {} } };
  });
}

// Paid unlock -> the full content kit: one capture, reframed into every format.
function runKit(job, onProgress) {
  const { html, preset, quality, durationSec } = job.payload;
  const htmlPath = path.join(WORK, `in-${job.id}.html`);
  fs.writeFileSync(htmlPath, html);
  return renderKit({
    input: htmlPath, preset: preset || 'auto', autoFormat: (preset || 'auto') === 'auto',
    quality: quality || 'high', durationSec: durationSec || undefined, autoDetect: !durationSec,
    watermark: false, maxHeight: null, removeOverlay: job.payload.removeOverlay, cropBottom: job.payload.cropBottom, outDir: WORK, onProgress,
  }).then((r) => {
    try { fs.unlinkSync(htmlPath); } catch (_) {}
    const cleanups = [];
    const kit = r.formats.map((f) => {
      const ext = path.extname(f.outPath).slice(1);
      const finalName = `${job.id}-${f.preset}.${ext}`;
      const finalPath = path.join(WORK, finalName);
      fs.renameSync(f.outPath, finalPath); cleanups.push(finalPath);
      return { preset: f.preset, label: f.label, url: `/files/${finalName}`, width: f.width, height: f.height, bytes: f.bytes };
    });
    return { kit, durationSec: r.durationSec, fps: r.fps, cleanup: () => cleanups.forEach((p) => { try { fs.unlinkSync(p); } catch (_) {} }) };
  });
}

// Capture-free analysis for the detect-and-confirm card: detect format + duration
// (incl. loop) without rendering. Returns the analysis straight as the job result.
function runAnalyze(job) {
  const { html } = job.payload;
  const htmlPath = path.join(WORK, `an-${job.id}.html`);
  fs.writeFileSync(htmlPath, html);
  return analyze({ input: htmlPath }).then((a) => {
    try { fs.unlinkSync(htmlPath); } catch (_) {}
    return a;
  });
}

const queue = new JobQueue({ concurrency: CONCURRENCY, processor: (job, op) =>
  job.payload.analyze ? runAnalyze(job) : (job.payload.kit ? runKit(job, op) : runRender(job, op)) });

// Allow the UI (hosted anywhere, e.g. Netlify) to call this render API.
// Lock CORS_ORIGIN to your Netlify URL in production; defaults to "*" for testing.
const CORS_ORIGIN = process.env.FRAMECAST_CORS_ORIGIN || '*';
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
function sendJSON(res, code, obj) { cors(res); res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); }
function serveFile(res, file) {
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    cors(res);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}

// Serve a file WITH HTTP range support. Safari/iOS require 206 Partial Content
// for <video> playback — without it the video silently refuses to play.
function serveRanged(req, res, file) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end('not found'); }
    cors(res);
    const type = MIME[path.extname(file)] || 'application/octet-stream';
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      let start = m && m[1] ? parseInt(m[1], 10) : 0;
      let end = m && m[2] ? parseInt(m[2], 10) : st.size - 1;
      if (isNaN(start) || isNaN(end) || start > end || end >= st.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end();
      }
      res.writeHead(206, {
        'Content-Type': type,
        'Content-Range': `bytes ${start}-${end}/${st.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
        'Cache-Control': 'public, max-age=3600',
      });
      fs.createReadStream(file, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': st.size, 'Cache-Control': 'public, max-age=3600' });
      fs.createReadStream(file).pipe(res);
    }
  });
}
function readBody(req, cb) {
  let body = ''; let big = false;
  req.on('data', (c) => { body += c; if (body.length > MAX_HTML_BYTES) { big = true; req.destroy(); } });
  req.on('end', () => cb(big ? null : body));
}
const cleanParams = (o) => ({
  html: o.html,
  name: (o.name || 'animation').replace(/[^a-z0-9_-]/gi, '').slice(0, 60) || 'animation',
  preset: o.preset || 'auto',
  durationSec: o.durationSec ? Math.min(75, Math.max(1, Number(o.durationSec))) : undefined,
  removeOverlay: !!o.removeOverlay,
  cropBottom: o.cropBottom ? Math.min(0.5, Math.max(0, Number(o.cropBottom))) : undefined,
});

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const baseUrl = `${(req.headers['x-forwarded-proto'] || 'http')}://${req.headers.host}`;

  // CORS preflight for cross-origin UIs (e.g. the Netlify-hosted front-end).
  if (req.method === 'OPTIONS') { cors(res); res.writeHead(204); return res.end(); }

  // Handoff: landing stashes an uploaded HTML file, studio fetches it by id.
  if (req.method === 'POST' && url.pathname === '/api/stash') {
    return readBody(req, (body) => {
      if (body === null) return sendJSON(res, 413, { error: 'File too large' });
      let o; try { o = JSON.parse(body); } catch { return sendJSON(res, 400, { error: 'Bad JSON' }); }
      if (!o.html || typeof o.html !== 'string') return sendJSON(res, 400, { error: 'Missing html' });
      const id = Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
      stash.set(id, { html: o.html, name: String(o.name || 'animation').slice(0, 80), ts: Date.now() });
      sendJSON(res, 200, { id });
    });
  }
  if (req.method === 'GET' && url.pathname.startsWith('/api/stash/')) {
    const id = url.pathname.split('/').pop();
    const s = stash.get(id);
    if (!s) return sendJSON(res, 404, { error: 'Handoff expired — drop the file again' });
    return sendJSON(res, 200, { html: s.html, name: s.name });
  }

  // 0) Detect-and-confirm: analyze the dropped file (format + duration + loop)
  //    WITHOUT rendering, so the studio can show "here's what we found" and let
  //    the user confirm/adjust before paying. Poll /api/jobs/:id for the result.
  if (req.method === 'POST' && url.pathname === '/api/analyze') {
    return readBody(req, (body) => {
      if (body === null) return sendJSON(res, 413, { error: 'File too large' });
      let o; try { o = JSON.parse(body); } catch { return sendJSON(res, 400, { error: 'Bad JSON' }); }
      if (!o.html || typeof o.html !== 'string') return sendJSON(res, 400, { error: 'Missing html' });
      const job = queue.add({ analyze: true, html: o.html, name: (o.name || 'animation') });
      sendJSON(res, 200, { jobId: job.id });
    });
  }

  // 1) Free preview render
  if (req.method === 'POST' && url.pathname === '/api/jobs') {
    return readBody(req, (body) => {
      if (body === null) return sendJSON(res, 413, { error: 'File too large' });
      let o; try { o = JSON.parse(body); } catch { return sendJSON(res, 400, { error: 'Bad JSON' }); }
      if (!o.html || typeof o.html !== 'string') return sendJSON(res, 400, { error: 'Missing html' });
      const params = cleanParams(o);
      const free = tierOpts('free');
      // Free is always a short teaser: cap length regardless of what was requested.
      const teaserSec = Math.min(params.durationSec || free.maxDurationSec, free.maxDurationSec);
      const job = queue.add({ ...params, durationSec: teaserSec, autoDetect: false,
        quality: free.quality, watermark: free.watermark, maxHeight: free.maxHeight });
      sources.set(job.id, { params, ts: Date.now() });
      sendJSON(res, 200, { jobId: job.id, tier: 'free', price: PRICING.perVideoLabel, teaserSec });
    });
  }

  // 2) Start checkout for one clean video
  if (req.method === 'POST' && url.pathname === '/api/checkout') {
    return readBody(req, async (body) => {
      let o; try { o = JSON.parse(body || '{}'); } catch { return sendJSON(res, 400, { error: 'Bad JSON' }); }
      if (!sources.has(o.jobId)) return sendJSON(res, 404, { error: 'Video expired — please re-render' });
      const returnTo = (o.returnTo && /^https?:\/\//.test(o.returnTo)) ? o.returnTo.replace(/\/$/, '') : baseUrl;
      try { const c = await createCheckout({ jobId: o.jobId, baseUrl, returnTo, plan: o.plan }); sendJSON(res, 200, { url: c.url, live: LIVE }); }
      catch (e) { sendJSON(res, 500, { error: e.message }); }
    });
  }

  // Stripe webhook — records the payment server-side even if the buyer's browser
  // never makes it back from the redirect. Needs the RAW body for signature check.
  if (req.method === 'POST' && url.pathname === '/api/stripe-webhook') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let event;
      try { event = verifyWebhook(Buffer.concat(chunks), req.headers['stripe-signature']); }
      catch (e) { return sendJSON(res, 400, { error: `Webhook signature failed: ${e.message}` }); }
      if (event && event.type === 'checkout.session.completed') {
        const s = event.data.object;
        const jobId = s && s.metadata && s.metadata.jobId;
        if (jobId) paid.set(jobId, true);
      }
      sendJSON(res, 200, { received: true });
    });
    return;
  }

  // dev-only fake checkout page
  if (req.method === 'GET' && url.pathname === '/api/dev-checkout') {
    const jobId = url.searchParams.get('jobId') || '';
    const rt = url.searchParams.get('returnTo') || baseUrl;
    const back = `${rt}/?paid=${encodeURIComponent(jobId)}&session=dev`;
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(`<!doctype html><meta charset=utf-8><body style="font-family:system-ui;background:#0b0e16;color:#eef2fb;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center"><h2>Dev checkout</h2><p>This stands in for Stripe while testing.</p><a href="${back}" style="display:inline-block;background:linear-gradient(120deg,#7c9bff,#56e0c0);color:#0b0e16;font-weight:700;padding:14px 22px;border-radius:12px;text-decoration:none">Pay ${PRICING.perVideoLabel} (simulated)</a></div></body>`);
  }

  // 3) After payment: verify + render the clean version
  if (req.method === 'POST' && url.pathname === '/api/unlock') {
    return readBody(req, async (body) => {
      let o; try { o = JSON.parse(body || '{}'); } catch { return sendJSON(res, 400, { error: 'Bad JSON' }); }
      const src = sources.get(o.jobId);
      if (!src) return sendJSON(res, 404, { error: 'Video expired — please re-render' });
      let ok = paid.get(o.jobId) === true;
      if (!ok && o.session) { try { ok = await verifyPaid({ sessionId: o.session }); } catch (e) { return sendJSON(res, 402, { error: 'Payment not verified' }); } }
      if (!ok && o.email) { try { ok = await hasActiveSubscription(o.email); } catch (e) {} }
      if (!ok) return sendJSON(res, 402, { error: 'Payment required' });
      paid.set(o.jobId, true);
      const pd = tierOpts('paid');
      const job = queue.add({ ...src.params, kit: true, quality: pd.quality });
      sendJSON(res, 200, { cleanJobId: job.id });
    });
  }

  // poll
  if (req.method === 'GET' && url.pathname.startsWith('/api/jobs/')) {
    const id = url.pathname.split('/').pop();
    const job = queue.get(id);
    if (!job) return sendJSON(res, 404, { error: 'Job not found or expired' });
    const out = { status: job.status, pct: job.pct, frame: job.frame, total: job.total };
    if (job.status === 'queued') out.position = queue.position(id);
    if (job.status === 'done') Object.assign(out, job.result);
    if (job.status === 'error') out.error = job.error;
    return sendJSON(res, 200, out);
  }

  if (req.method === 'GET' && url.pathname.startsWith('/files/')) return serveRanged(req, res, path.join(WORK, path.basename(url.pathname)));
  if (url.pathname === '/healthz') return sendJSON(res, 200, { ok: true, active: queue.active, payments: LIVE ? 'stripe' : 'dev' });
  // Flat layout: only ever serve the UI file (never expose source .js).
  return serveFile(res, path.join(PUBLIC, 'index.html'));
});

server.listen(PORT, () => console.log(`Framecast cloud on :${PORT} · payments: ${LIVE ? 'Stripe' : 'DEV mode'} · per-video ${PRICING.perVideoLabel}`));
module.exports = { server };
