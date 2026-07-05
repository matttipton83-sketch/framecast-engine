import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { Board } from '../components/Board';
import { Keyboard } from '../components/Keyboard';
import { ScalePanel } from '../components/ScalePanel';
import { ValueChart } from '../components/ValueChart';
import { WinBanner } from '../components/WinBanner';
import {
  buildGridIndex,
  Fill,
  getAllStatuses,
  initialFill,
  isPuzzleSolved,
} from '../model/gameState';
import { cellKey, Direction, Entry, Puzzle } from '../model/types';
import { theme } from '../theme';

interface GameScreenProps {
  puzzle: Puzzle;
}

/** First white, non-anchor cell — a sensible place to drop the cursor. */
function firstEditableCell(puzzle: Puzzle, index: ReturnType<typeof buildGridIndex>) {
  for (const entry of puzzle.entries) {
    for (const [r, c] of entry.cells) {
      const key = cellKey(r, c);
      if (!index.anchors.has(key)) return { key, dir: entry.dir };
    }
  }
  const first = puzzle.entries[0];
  return { key: cellKey(first.cells[0][0], first.cells[0][1]), dir: first.dir };
}

export function GameScreen({ puzzle }: GameScreenProps) {
  const index = useMemo(() => buildGridIndex(puzzle), [puzzle]);
  const { width } = useWindowDimensions();

  const [fill, setFill] = useState<Fill>(() => initialFill(puzzle));
  const start = useMemo(() => firstEditableCell(puzzle, index), [puzzle, index]);
  const [selectedKey, setSelectedKey] = useState<string>(start.key);
  const [activeDir, setActiveDir] = useState<Direction>(start.dir);

  const [startedAt, setStartedAt] = useState<number>(() => Date.now());
  const [now, setNow] = useState<number>(() => Date.now());
  const [solvedAt, setSolvedAt] = useState<number | null>(null);

  const statuses = useMemo(() => getAllStatuses(puzzle, fill), [puzzle, fill]);
  const solved = useMemo(() => isPuzzleSolved(puzzle, fill), [puzzle, fill]);

  // Freeze the timer the moment the puzzle is solved.
  useEffect(() => {
    if (solved && solvedAt === null) setSolvedAt(Date.now());
  }, [solved, solvedAt]);

  // Tick the timer once a second while unsolved.
  useEffect(() => {
    if (solvedAt !== null) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [solvedAt]);

  const elapsedMs = (solvedAt ?? now) - startedAt;

  const activeEntry: Entry | null = useMemo(() => {
    const entries = index.cellEntries.get(selectedKey) ?? [];
    return (
      entries.find((e) => e.dir === activeDir) ?? entries[0] ?? null
    );
  }, [index, selectedKey, activeDir]);

  function handleCellPress(row: number, col: number) {
    const key = cellKey(row, col);
    const entries = index.cellEntries.get(key) ?? [];
    if (entries.length === 0) return;

    if (key === selectedKey && entries.length > 1) {
      // Re-tapping an intersection flips the active direction.
      setActiveDir((d) => (d === 'across' ? 'down' : 'across'));
      return;
    }
    setSelectedKey(key);
    if (!entries.some((e) => e.dir === activeDir)) {
      setActiveDir(entries[0].dir);
    }
  }

  function advance(delta: number) {
    if (!activeEntry) return;
    const cells = activeEntry.cells;
    const i = cells.findIndex(([r, c]) => cellKey(r, c) === selectedKey);
    const ni = i + delta;
    if (ni >= 0 && ni < cells.length) {
      const [r, c] = cells[ni];
      setSelectedKey(cellKey(r, c));
    }
  }

  function handleKey(letter: string) {
    if (solvedAt !== null) return;
    if (index.anchors.has(selectedKey)) {
      advance(1);
      return;
    }
    setFill((f) => ({ ...f, [selectedKey]: letter }));
    advance(1);
  }

  function handleBackspace() {
    if (solvedAt !== null) return;
    const hasLetter = !!fill[selectedKey] && !index.anchors.has(selectedKey);
    if (hasLetter) {
      setFill((f) => {
        const next = { ...f };
        delete next[selectedKey];
        return next;
      });
    } else {
      advance(-1);
    }
  }

  function selectEntryById(id: string) {
    const entry = puzzle.entries.find((e) => e.id === id);
    if (!entry) return;
    setActiveDir(entry.dir);
    // Jump to the first non-anchor cell of that entry, else its first cell.
    const target =
      entry.cells.find(([r, c]) => !index.anchors.has(cellKey(r, c))) ??
      entry.cells[0];
    setSelectedKey(cellKey(target[0], target[1]));
  }

  function reset() {
    setFill(initialFill(puzzle));
    setSelectedKey(start.key);
    setActiveDir(start.dir);
    const t = Date.now();
    setStartedAt(t);
    setNow(t);
    setSolvedAt(null);
  }

  // Size the board to fit the screen width with a little breathing room.
  const [rows, cols] = puzzle.size;
  const gap = 6;
  const maxBoardWidth = Math.min(width - 32, 380);
  const cellSize = Math.floor((maxBoardWidth - gap * (cols - 1)) / cols);
  const solvedCount = statuses.filter((s) => s.solved).length;

  return (
    <View style={styles.screen}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.header}>
          <Text style={styles.brand}>GRAM</Text>
          <Text style={styles.meta}>
            {puzzle.id} · {solvedCount}/{statuses.length} balanced
          </Text>
        </View>

        <Text style={styles.tagline}>
          The only clue is weight. Make every row and column hit its number.
        </Text>

        {solved ? (
          <WinBanner elapsedMs={elapsedMs} onReset={reset} />
        ) : (
          <Board
            puzzle={puzzle}
            gridIndex={index}
            fill={fill}
            selectedKey={selectedKey}
            activeEntry={activeEntry}
            cellSize={cellSize}
            gap={gap}
            onCellPress={handleCellPress}
          />
        )}

        <ScalePanel
          statuses={statuses}
          activeEntryId={activeEntry?.id ?? null}
          onSelectEntry={selectEntryById}
        />

        <ValueChart defaultOpen={rows <= 3} />
      </ScrollView>

      {!solved && (
        <View style={styles.keyboardWrap}>
          <Keyboard onKey={handleKey} onBackspace={handleBackspace} />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.bg },
  scroll: { padding: 16, gap: 16 },
  header: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
  },
  brand: {
    color: theme.text,
    fontSize: 28,
    fontWeight: '900',
    letterSpacing: 4,
  },
  meta: { color: theme.textDim, fontSize: 13, fontWeight: '600' },
  tagline: {
    color: theme.textDim,
    fontSize: 13,
    lineHeight: 18,
    marginTop: -6,
  },
  keyboardWrap: {
    paddingHorizontal: 8,
    paddingTop: 8,
    paddingBottom: 20,
    backgroundColor: theme.surface,
    borderTopWidth: 1,
    borderTopColor: theme.line,
  },
});
