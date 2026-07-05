// Shared puzzle types. These mirror the JSON shape defined in the build spec
// (section 6) so that offline-generated puzzles drop straight into the client.

export type Coord = [row: number, col: number];

export type Direction = 'across' | 'down';

export interface Entry {
  id: string;
  dir: Direction;
  /** Ordered list of cells (left→right for across, top→bottom for down). */
  cells: Coord[];
  /** Target weight: the sum every letter in this entry must add up to. */
  weight: number;
}

export interface Anchor {
  cell: Coord;
  letter: string;
}

export interface Puzzle {
  id: string;
  size: [rows: number, cols: number];
  blackCells: Coord[];
  entries: Entry[];
  anchors: Anchor[];
  difficulty: 'easy' | 'medium' | 'hard';
}

/** Stable string key for a cell, used to index the fill map. */
export function cellKey(row: number, col: number): string {
  return `${row},${col}`;
}
