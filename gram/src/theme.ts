// A small, calm palette. The game is about balance, so feedback colors lean
// toward a physical "scale settling" feel: neutral slate → amber (close) → green.
export const theme = {
  bg: '#0f1419',
  surface: '#1b232c',
  surfaceAlt: '#232e39',
  line: '#33414f',
  text: '#eef2f6',
  textDim: '#8fa0b0',
  textFaint: '#5f7183',

  cell: '#1f2a35',
  cellSelected: '#2f4a63',
  cellActiveEntry: '#26313d',
  cellBlack: '#0a0e12',
  anchor: '#3a2f16',

  accent: '#7fb5ff',

  under: '#7f8c9b', // sum below target
  close: '#e0b341', // within ±3 of target
  over: '#e0685c', // sum above target
  balanced: '#4bd08b', // exactly on target
  solved: '#4bd08b',
} as const;

export type Theme = typeof theme;
