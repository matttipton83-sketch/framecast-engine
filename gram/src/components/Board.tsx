import React from 'react';
import { StyleSheet, View } from 'react-native';
import { buildGridIndex, Fill, GridIndex } from '../model/gameState';
import { cellKey, Entry, Puzzle } from '../model/types';
import { Cell } from './Cell';

interface BoardProps {
  puzzle: Puzzle;
  gridIndex: GridIndex;
  fill: Fill;
  selectedKey: string | null;
  activeEntry: Entry | null;
  cellSize: number;
  gap: number;
  onCellPress: (row: number, col: number) => void;
}

function BoardComponent({
  puzzle,
  gridIndex,
  fill,
  selectedKey,
  activeEntry,
  cellSize,
  gap,
  onCellPress,
}: BoardProps) {
  const [rows, cols] = puzzle.size;
  const activeKeys = new Set(
    activeEntry ? activeEntry.cells.map(([r, c]) => cellKey(r, c)) : []
  );

  return (
    <View style={styles.board}>
      {Array.from({ length: rows }, (_, r) => (
        <View key={r} style={[styles.row, { gap }]}>
          {Array.from({ length: cols }, (_, c) => {
            const key = cellKey(r, c);
            const isBlack = gridIndex.black.has(key);
            const start = gridIndex.startNumbers.get(key);
            return (
              <Cell
                key={key}
                size={cellSize}
                letter={fill[key] ?? ''}
                isBlack={isBlack}
                isAnchor={gridIndex.anchors.has(key)}
                isSelected={selectedKey === key}
                inActiveEntry={activeKeys.has(key)}
                acrossTarget={start?.across?.weight}
                downTarget={start?.down?.weight}
                onPress={isBlack ? undefined : () => onCellPress(r, c)}
              />
            );
          })}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  board: { alignSelf: 'center' },
  row: { flexDirection: 'row', marginBottom: 6 },
});

export const Board = React.memo(BoardComponent);

// Re-exported for convenience so screens can build the index once.
export { buildGridIndex };
