// The A–Z value model. This is the whole conceit of the game: every letter is
// worth its 1-indexed position in the alphabet, and a word's "weight" is the
// sum of its letters. Weight is the *only* clue a player gets.

export const A_CHAR_CODE = 'A'.charCodeAt(0);

/** Value of a single uppercase letter, e.g. 'A' -> 1, 'Z' -> 26. */
export function letterValue(letter: string): number {
  if (!letter) return 0;
  const code = letter.toUpperCase().charCodeAt(0) - A_CHAR_CODE + 1;
  return code >= 1 && code <= 26 ? code : 0;
}

/** Weight of a word = sum of its letter values. Ignores non-letters. */
export function wordWeight(word: string): number {
  let total = 0;
  for (const ch of word) total += letterValue(ch);
  return total;
}

/** The full A–Z chart, used for the on-screen value reference. */
export const ALPHABET: { letter: string; value: number }[] = Array.from(
  { length: 26 },
  (_, i) => ({ letter: String.fromCharCode(A_CHAR_CODE + i), value: i + 1 })
);
