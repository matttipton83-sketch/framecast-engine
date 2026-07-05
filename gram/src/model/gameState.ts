import { isValidWord } from './dictionary';
import { letterValue } from './letters';
import { Anchor, cellKey, Coord, Entry, Puzzle } from './types';

// The player's grid state: a map from cell key ("row,col") to a single
// uppercase letter. Empty cells are simply absent from the map.
export type Fill = Record<string, string>;

/** Live status of one entry, derived from the current fill. Drives Open mode. */
export interface EntryStatus {
  entry: Entry;
  letters: string[]; // one per cell; '' where empty
  word: string; // filled letters joined (may be partial)
  filled: boolean; // every cell has a letter
  currentSum: number; // running weight of the filled letters
  target: number; // the printed weight clue
  delta: number; // currentSum - target (negative = under, positive = over)
  isWord: boolean; // filled AND a valid dictionary word
  balanced: boolean; // currentSum === target
  solved: boolean; // filled AND balanced AND a valid word
}

/** The starting fill: just the puzzle's anchor letters. */
export function initialFill(puzzle: Puzzle): Fill {
  const fill: Fill = {};
  for (const a of puzzle.anchors) {
    fill[cellKey(a.cell[0], a.cell[1])] = a.letter.toUpperCase();
  }
  return fill;
}

export function anchorKeySet(anchors: Anchor[]): Set<string> {
  return new Set(anchors.map((a) => cellKey(a.cell[0], a.cell[1])));
}

export function blackKeySet(black: Coord[]): Set<string> {
  return new Set(black.map(([r, c]) => cellKey(r, c)));
}

/** Compute the derived status of a single entry against the current fill. */
export function getEntryStatus(entry: Entry, fill: Fill): EntryStatus {
  const letters = entry.cells.map(([r, c]) => fill[cellKey(r, c)] ?? '');
  const filled = letters.every((l) => l !== '');
  const currentSum = letters.reduce((sum, l) => sum + letterValue(l), 0);
  const word = letters.join('');
  const balanced = currentSum === entry.weight;
  const isWord = filled && isValidWord(word);
  return {
    entry,
    letters,
    word,
    filled,
    currentSum,
    target: entry.weight,
    delta: currentSum - entry.weight,
    isWord,
    balanced,
    solved: filled && balanced && isWord,
  };
}

/** Status for every entry in the puzzle. */
export function getAllStatuses(puzzle: Puzzle, fill: Fill): EntryStatus[] {
  return puzzle.entries.map((e) => getEntryStatus(e, fill));
}

/** The whole puzzle is solved when every entry is solved. */
export function isPuzzleSolved(puzzle: Puzzle, fill: Fill): boolean {
  return puzzle.entries.every((e) => getEntryStatus(e, fill).solved);
}

// ── Grid geometry helpers (shared by the renderer) ─────────────────────────

export interface GridIndex {
  rows: number;
  cols: number;
  black: Set<string>;
  anchors: Set<string>;
  /** Entries that pass through each white cell (across and/or down). */
  cellEntries: Map<string, Entry[]>;
  /** Clue number shown at the start cell of each entry, keyed by cell. */
  startNumbers: Map<string, { across?: Entry; down?: Entry }>;
}

export function buildGridIndex(puzzle: Puzzle): GridIndex {
  const black = blackKeySet(puzzle.blackCells);
  const anchors = anchorKeySet(puzzle.anchors);
  const cellEntries = new Map<string, Entry[]>();
  const startNumbers = new Map<string, { across?: Entry; down?: Entry }>();

  for (const entry of puzzle.entries) {
    entry.cells.forEach(([r, c]) => {
      const key = cellKey(r, c);
      const list = cellEntries.get(key) ?? [];
      list.push(entry);
      cellEntries.set(key, list);
    });
    const [sr, sc] = entry.cells[0];
    const startKey = cellKey(sr, sc);
    const start = startNumbers.get(startKey) ?? {};
    start[entry.dir] = entry;
    startNumbers.set(startKey, start);
  }

  return {
    rows: puzzle.size[0],
    cols: puzzle.size[1],
    black,
    anchors,
    cellEntries,
    startNumbers,
  };
}
