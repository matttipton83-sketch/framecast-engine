// presets.js — output format presets for Framecast
// Every dimension is even (required by H.264 yuv420p).

const PRESETS = {
  'youtube-1080': {
    label: 'YouTube / Landscape 1080p',
    width: 1920, height: 1080, container: 'mp4', fps: 30,
    description: '16:9 — the safe default for YouTube and most uploads.',
  },
  'youtube-4k': {
    label: 'YouTube / Landscape 4K',
    width: 3840, height: 2160, container: 'mp4', fps: 30,
    description: '16:9 ultra-high-res. Bigger files, crisp on large screens.',
  },
  'vertical-1080': {
    label: 'Vertical 9:16 (TikTok / Reels / Shorts)',
    width: 1080, height: 1920, container: 'mp4', fps: 30,
    description: 'Full-screen mobile — the gold standard for short-form video.',
  },
  'square-1080': {
    label: 'Square 1:1 (Instagram feed)',
    width: 1080, height: 1080, container: 'mp4', fps: 30,
    description: 'Square feed posts.',
  },
  'webm-transparent': {
    label: 'Transparent WebM (overlays)',
    width: 1920, height: 1080, container: 'webm', fps: 30, transparent: true,
    description: 'Alpha-channel video for compositing over other footage.',
  },
  'gif': {
    label: 'Animated GIF',
    width: 800, height: 800, container: 'gif', fps: 24,
    description: 'Quick shareable loop. Smaller, lower fidelity than MP4.',
  },
};

// Quality -> CRF (lower = higher quality / bigger file). Tuned per container.
// NOTE: at a fixed CRF, x264 presets give ~identical visual quality — slower
// presets only shrink the file. We're not bandwidth-bound here, so we favor
// FAST presets: 'medium' is ~2-3x faster than 'slow' with no visible loss.
const QUALITY = {
  high:     { crf: 17, preset: 'medium'   },
  balanced: { crf: 20, preset: 'fast'     },
  small:    { crf: 23, preset: 'veryfast' },
  preview:  { crf: 28, preset: 'veryfast' }, // free teaser: fastest encode, frees CPU
  // Throwaway master for the kit: near-lossless so the 3 derived encodes don't
  // compound artifacts, but encoded as fast as possible since it's deleted after.
  intermediate: { crf: 14, preset: 'ultrafast' },
};

module.exports = { PRESETS, QUALITY };
