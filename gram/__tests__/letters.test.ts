import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ALPHABET, letterValue, wordWeight } from '../src/model/letters';

test('letterValue maps A-Z to 1-26', () => {
  assert.equal(letterValue('A'), 1);
  assert.equal(letterValue('Z'), 26);
  assert.equal(letterValue('m'), 13); // case-insensitive
  assert.equal(letterValue(''), 0);
  assert.equal(letterValue('4'), 0); // non-letters have no value
});

test('wordWeight sums letter values', () => {
  assert.equal(wordWeight('CAT'), 24); // 3 + 1 + 20
  assert.equal(wordWeight('ARE'), 24); // 1 + 18 + 5
  assert.equal(wordWeight('TEN'), 39); // 20 + 5 + 14
  assert.equal(wordWeight(''), 0);
});

test('ALPHABET has 26 entries in order', () => {
  assert.equal(ALPHABET.length, 26);
  assert.deepEqual(ALPHABET[0], { letter: 'A', value: 1 });
  assert.deepEqual(ALPHABET[25], { letter: 'Z', value: 26 });
});
