import { Puzzle } from './types';

// The hardcoded sample from the build spec (section 10). Intended solution is
// CAT / ARE / TEN, which is a symmetric word square: the three across words and
// the three down words are the same three words.
//
//   C A T   -> across 24 / 24 / 39
//   A R E   -> down   24 / 24 / 39
//   T E N
export const SAMPLE_PUZZLE: Puzzle = {
  id: 'sample-001',
  size: [3, 3],
  blackCells: [],
  entries: [
    { id: 'A1', dir: 'across', cells: [[0, 0], [0, 1], [0, 2]], weight: 24 },
    { id: 'A2', dir: 'across', cells: [[1, 0], [1, 1], [1, 2]], weight: 24 },
    { id: 'A3', dir: 'across', cells: [[2, 0], [2, 1], [2, 2]], weight: 39 },
    { id: 'D1', dir: 'down', cells: [[0, 0], [1, 0], [2, 0]], weight: 24 },
    { id: 'D2', dir: 'down', cells: [[0, 1], [1, 1], [2, 1]], weight: 24 },
    { id: 'D3', dir: 'down', cells: [[0, 2], [1, 2], [2, 2]], weight: 39 },
  ],
  anchors: [{ cell: [0, 0], letter: 'C' }],
  difficulty: 'easy',
};
