import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { letterValue } from '../model/letters';
import { theme } from '../theme';

const ROWS = ['QWERTYUIOP', 'ASDFGHJKL', 'ZXCVBNM'];

interface KeyboardProps {
  onKey: (letter: string) => void;
  onBackspace: () => void;
}

function Key({ letter, onKey }: { letter: string; onKey: (l: string) => void }) {
  return (
    <Pressable style={styles.key} onPress={() => onKey(letter)}>
      <Text style={styles.keyLetter}>{letter}</Text>
      <Text style={styles.keyValue}>{letterValue(letter)}</Text>
    </Pressable>
  );
}

function KeyboardComponent({ onKey, onBackspace }: KeyboardProps) {
  return (
    <View style={styles.keyboard}>
      {ROWS.map((row, i) => (
        <View key={i} style={styles.keyRow}>
          {i === 2 && <View style={styles.spacer} />}
          {row.split('').map((l) => (
            <Key key={l} letter={l} onKey={onKey} />
          ))}
          {i === 2 && (
            <Pressable style={[styles.key, styles.wideKey]} onPress={onBackspace}>
              <Text style={styles.keyLetter}>⌫</Text>
            </Pressable>
          )}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  keyboard: { gap: 6, paddingHorizontal: 2 },
  keyRow: { flexDirection: 'row', justifyContent: 'center', gap: 5 },
  spacer: { width: 16 },
  key: {
    flex: 1,
    maxWidth: 40,
    minWidth: 26,
    height: 46,
    backgroundColor: theme.surfaceAlt,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  wideKey: { maxWidth: 56, flex: 1.4 },
  keyLetter: { color: theme.text, fontSize: 16, fontWeight: '700' },
  keyValue: { color: theme.textFaint, fontSize: 9, fontWeight: '600' },
});

export const Keyboard = React.memo(KeyboardComponent);
