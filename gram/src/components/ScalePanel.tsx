import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { EntryStatus } from '../model/gameState';
import { theme } from '../theme';

function stateColor(s: EntryStatus): string {
  if (s.solved) return theme.solved;
  if (s.balanced) return theme.balanced; // on target but not yet a valid word
  if (s.delta > 0) return theme.over;
  if (Math.abs(s.delta) <= 3) return theme.close;
  return theme.under;
}

function deltaLabel(s: EntryStatus): string {
  if (s.solved) return '✓';
  if (s.delta === 0) return '=';
  return s.delta > 0 ? `+${s.delta}` : `${s.delta}`;
}

interface ScaleRowProps {
  status: EntryStatus;
  isActive: boolean;
  onPress: () => void;
}

function ScaleRow({ status, isActive, onPress }: ScaleRowProps) {
  const color = stateColor(status);
  // Fraction of the target reached, clamped for the bar width.
  const frac = status.target > 0 ? Math.min(status.currentSum / status.target, 1) : 0;

  return (
    <Pressable
      onPress={onPress}
      style={[styles.row, isActive && styles.rowActive]}
    >
      <Text style={styles.id}>{status.entry.id}</Text>

      <View style={styles.barWrap}>
        <View style={[styles.barFill, { width: `${frac * 100}%`, backgroundColor: color }]} />
        <View style={styles.targetTick} />
      </View>

      <Text style={styles.sum}>
        <Text style={{ color }}>{status.currentSum}</Text>
        <Text style={styles.slash}> / {status.target}</Text>
      </Text>

      <Text style={[styles.delta, { color }]}>{deltaLabel(status)}</Text>
    </Pressable>
  );
}

interface ScalePanelProps {
  statuses: EntryStatus[];
  activeEntryId: string | null;
  onSelectEntry: (id: string) => void;
}

export function ScalePanel({ statuses, activeEntryId, onSelectEntry }: ScalePanelProps) {
  return (
    <View style={styles.panel}>
      <Text style={styles.heading}>Scales</Text>
      {statuses.map((s) => (
        <ScaleRow
          key={s.entry.id}
          status={s}
          isActive={s.entry.id === activeEntryId}
          onPress={() => onSelectEntry(s.entry.id)}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    backgroundColor: theme.surface,
    borderRadius: 12,
    padding: 12,
    gap: 6,
  },
  heading: {
    color: theme.textDim,
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1,
    textTransform: 'uppercase',
    marginBottom: 2,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 5,
    paddingHorizontal: 6,
    borderRadius: 8,
  },
  rowActive: {
    backgroundColor: theme.surfaceAlt,
  },
  id: {
    width: 30,
    color: theme.text,
    fontWeight: '700',
    fontSize: 13,
  },
  barWrap: {
    flex: 1,
    height: 8,
    backgroundColor: theme.cellBlack,
    borderRadius: 4,
    overflow: 'hidden',
    position: 'relative',
  },
  barFill: {
    height: '100%',
    borderRadius: 4,
  },
  targetTick: {
    position: 'absolute',
    right: 0,
    top: 0,
    bottom: 0,
    width: 2,
    backgroundColor: theme.line,
  },
  sum: {
    width: 66,
    textAlign: 'right',
    fontVariant: ['tabular-nums'],
    fontSize: 13,
    fontWeight: '600',
  },
  slash: {
    color: theme.textDim,
  },
  delta: {
    width: 34,
    textAlign: 'right',
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
    fontSize: 13,
  },
});
