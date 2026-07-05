import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isValidWord } from '../src/model/dictionary';
import {
  buildGridIndex,
  Fill,
  getEntryStatus,
  initialFill,
  isPuzzleSolved,
} from '../src/model/gameState';
import { SAMPLE_PUZZLE } from '../src/model/samplePuzzle';
import { cellKey } from '../src/model/types';

/** Build a fill from a flat 3x3 solution string like "CATARETEN". */
function fillFromSolution(solution: string): Fill {
  const fill: Fill = {};
  let i = 0;
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      fill[cellKey(r, c)] = solution[i++];
    }
  }
  return fill;
}

test('dictionary knows the sample words and rejects nonsense', () => {
  assert.ok(isValidWord('CAT'));
  assert.ok(isValidWord('are')); // case-insensitive
  assert.ok(isValidWord('TEN'));
  assert.ok(!isValidWord('ZZQ'));
  assert.ok(!isValidWord(''));
});

test('initialFill only contains the anchor', () => {
  const fill = initialFill(SAMPLE_PUZZLE);
  assert.deepEqual(fill, { '0,0': 'C' });
});

test('getEntryStatus reports running sum and delta before solved', () => {
  // Only the anchor C is placed in A1 (C A T): current sum 3, target 24.
  const fill = initialFill(SAMPLE_PUZZLE);
  const a1 = SAMPLE_PUZZLE.entries.find((e) => e.id === 'A1')!;
  const s = getEntryStatus(a1, fill);
  assert.equal(s.currentSum, 3);
  assert.equal(s.target, 24);
  assert.equal(s.delta, -21);
  assert.equal(s.filled, false);
  assert.equal(s.solved, false);
});

test('correct CAT/ARE/TEN solution solves the puzzle', () => {
  const fill = fillFromSolution('CATARETEN');
  const solved = isPuzzleSolved(SAMPLE_PUZZLE, fill);
  assert.ok(solved);
});

test('a fill that hits the weights but is not a word does NOT solve', () => {
  // Row 0 "CAT" is fine, but craft a grid where a sum matches yet a word fails.
  // "DBS" = 4+2+19 = 25 (wrong sum too) — simplest: break one word to gibberish
  // while keeping the anchor. Replace TEN with "TNE" (20+14+5 = 39, right sum,
  // not a word) to prove sum-only is insufficient.
  const fill = fillFromSolution('CATARETNE');
  const a3 = getEntryStatus(SAMPLE_PUZZLE.entries.find((e) => e.id === 'A3')!, fill);
  assert.equal(a3.currentSum, 39); // sum is right
  assert.equal(a3.balanced, true);
  assert.equal(a3.isWord, false); // but TNE is not a word
  assert.equal(a3.solved, false);
  assert.equal(isPuzzleSolved(SAMPLE_PUZZLE, fill), false);
});

test('a valid word with the wrong sum does NOT solve', () => {
  // Replace row 0 with "BAT" (2+1+20 = 23, target 24) — real word, wrong weight.
  const fill = fillFromSolution('BATARETEN');
  const a1 = getEntryStatus(SAMPLE_PUZZLE.entries.find((e) => e.id === 'A1')!, fill);
  assert.equal(a1.isWord, true);
  assert.equal(a1.balanced, false);
  assert.equal(a1.solved, false);
  assert.equal(isPuzzleSolved(SAMPLE_PUZZLE, fill), false);
});

test('buildGridIndex maps cells to their across and down entries', () => {
  const index = buildGridIndex(SAMPLE_PUZZLE);
  const center = index.cellEntries.get(cellKey(1, 1))!;
  assert.equal(center.length, 2); // center cell is in A2 and D2
  const start = index.startNumbers.get(cellKey(0, 0))!;
  assert.equal(start.across?.id, 'A1');
  assert.equal(start.down?.id, 'D1');
});
