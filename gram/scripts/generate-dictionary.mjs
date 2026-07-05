#!/usr/bin/env node
// Regenerates src/model/dictionary.words.ts — the bundled word-membership list.
//
// Pipeline:
//   1. Download the dwyl/english-words list (public domain).
//   2. Strip CRLF, filter to lengths 2..MAX_LEN, uppercase, de-dupe, sort.
//   3. Emit a compact newline-joined blob as a TS module.
//
// The client builds a Set from this blob for O(1) offline word validation.
// This is intentionally a broad "is it a real word" check — puzzle uniqueness is
// the generator's job (see MVP step 4), not the client's.
//
// Usage: node scripts/generate-dictionary.mjs
import { writeFileSync } from 'node:fs';

const SOURCE = 'https://raw.githubusercontent.com/dwyl/english-words/master/words_alpha.txt';
const MAX_LEN = 6; // small daily grids only need short words for the MVP
const OUT = new URL('../src/model/dictionary.words.ts', import.meta.url);

const res = await fetch(SOURCE);
if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
const raw = await res.text();

const words = [
  ...new Set(
    raw
      .split('\n')
      .map((w) => w.replace(/\r/g, '').trim().toUpperCase())
      .filter((w) => w.length >= 2 && w.length <= MAX_LEN && /^[A-Z]+$/.test(w))
  ),
].sort();

const header =
  `// AUTO-GENERATED — do not edit by hand.\n` +
  `// Source: dwyl/english-words (public domain), filtered to length 2-${MAX_LEN}, uppercased.\n` +
  `// Regenerate with scripts/generate-dictionary.mjs\n`;

const out =
  header +
  `export const WORD_COUNT = ${words.length};\n\n` +
  'export const WORD_BLOB = `' +
  words.join('\\n') +
  '`;\n';

writeFileSync(OUT, out);
console.log(`Wrote ${words.length} words to ${OUT.pathname}`);
