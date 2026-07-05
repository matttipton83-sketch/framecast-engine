import { WORD_BLOB, WORD_COUNT } from './dictionary.words';

// Offline word validation. The bundled blob is a newline-joined, uppercased word
// list; we lazily inflate it into a Set on first use so app startup stays cheap.

let wordSet: Set<string> | null = null;

function ensureLoaded(): Set<string> {
  if (wordSet === null) {
    wordSet = new Set(WORD_BLOB.split('\n'));
  }
  return wordSet;
}

/** True if `word` is in the bundled dictionary (case-insensitive). */
export function isValidWord(word: string): boolean {
  if (!word) return false;
  return ensureLoaded().has(word.toUpperCase());
}

export const dictionarySize = WORD_COUNT;
