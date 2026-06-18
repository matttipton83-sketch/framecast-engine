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
const QUALITY = {
  high:     { crf: 16, preset: 'slow'     },
  balanced: { crf: 19, preset: 'medium'   },
  small:    { crf: 23, preset: 'medium'   },
  preview:  { crf: 28, preset: 'veryfast' }, // free teaser: fastest encode, frees CPU
};

module.exports = { PRESETS, QUALITY };
