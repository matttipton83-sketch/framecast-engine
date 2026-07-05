import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { letterValue } from '../model/letters';
import { theme } from '../theme';

export interface CellProps {
  size: number;
  letter: string;
  isBlack: boolean;
  isAnchor: boolean;
  isSelected: boolean;
  inActiveEntry: boolean;
  /** Small crossword-style target badges shown at an entry's start cell. */
  acrossTarget?: number;
  downTarget?: number;
  onPress?: () => void;
}

function CellComponent({
  size,
  letter,
  isBlack,
  isAnchor,
  isSelected,
  inActiveEntry,
  acrossTarget,
  downTarget,
  onPress,
}: CellProps) {
  if (isBlack) {
    return <View style={[styles.cell, styles.black, { width: size, height: size }]} />;
  }

  const bg = isSelected
    ? theme.cellSelected
    : inActiveEntry
    ? theme.cellActiveEntry
    : isAnchor
    ? theme.anchor
    : theme.cell;

  const value = letterValue(letter);

  return (
    <Pressable
      onPress={onPress}
      style={[
        styles.cell,
        {
          width: size,
          height: size,
          backgroundColor: bg,
          borderColor: isSelected ? theme.accent : theme.line,
        },
      ]}
    >
      {(acrossTarget !== undefined || downTarget !== undefined) && (
        <Text style={styles.targetBadge} numberOfLines={1}>
          {acrossTarget !== undefined ? `${acrossTarget}→` : ''}
          {acrossTarget !== undefined && downTarget !== undefined ? ' ' : ''}
          {downTarget !== undefined ? `${downTarget}↓` : ''}
        </Text>
      )}

      <Text style={[styles.letter, { fontSize: size * 0.42 }]}>{letter}</Text>

      {value > 0 && (
        <Text style={styles.value} numberOfLines={1}>
          {value}
        </Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  cell: {
    borderWidth: 1,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  black: {
    backgroundColor: theme.cellBlack,
    borderColor: theme.cellBlack,
  },
  letter: {
    color: theme.text,
    fontWeight: '700',
  },
  targetBadge: {
    position: 'absolute',
    top: 2,
    left: 3,
    right: 3,
    fontSize: 9,
    color: theme.textFaint,
    fontWeight: '700',
  },
  value: {
    position: 'absolute',
    bottom: 2,
    right: 4,
    fontSize: 10,
    color: theme.textFaint,
    fontWeight: '600',
  },
});

export const Cell = React.memo(CellComponent);
