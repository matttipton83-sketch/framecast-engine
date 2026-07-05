import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { ALPHABET } from '../model/letters';
import { theme } from '../theme';

/** The A–Z value reference. Collapsible so it stays out of the way once learned. */
export function ValueChart({ defaultOpen = false }: { defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <View style={styles.wrap}>
      <Pressable style={styles.header} onPress={() => setOpen((o) => !o)}>
        <Text style={styles.headerText}>A–Z values</Text>
        <Text style={styles.chevron}>{open ? '▾' : '▸'}</Text>
      </Pressable>

      {open && (
        <View style={styles.grid}>
          {ALPHABET.map(({ letter, value }) => (
            <View key={letter} style={styles.chip}>
              <Text style={styles.chipLetter}>{letter}</Text>
              <Text style={styles.chipValue}>{value}</Text>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    backgroundColor: theme.surface,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  headerText: {
    color: theme.textDim,
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  chevron: { color: theme.textDim, fontSize: 12 },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 5,
    marginTop: 10,
  },
  chip: {
    width: 34,
    paddingVertical: 4,
    borderRadius: 6,
    backgroundColor: theme.surfaceAlt,
    alignItems: 'center',
  },
  chipLetter: { color: theme.text, fontSize: 13, fontWeight: '700' },
  chipValue: { color: theme.textFaint, fontSize: 10, fontWeight: '600' },
});
