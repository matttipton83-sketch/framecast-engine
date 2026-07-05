import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { theme } from '../theme';

interface WinBannerProps {
  elapsedMs: number;
  onReset: () => void;
}

function formatTime(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function WinBanner({ elapsedMs, onReset }: WinBannerProps) {
  return (
    <View style={styles.banner}>
      <Text style={styles.emoji}>⚖️</Text>
      <Text style={styles.title}>Balanced!</Text>
      <Text style={styles.subtitle}>
        Every scale settled in {formatTime(elapsedMs)}.
      </Text>
      <Pressable style={styles.button} onPress={onReset}>
        <Text style={styles.buttonText}>Play again</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    backgroundColor: theme.surface,
    borderRadius: 16,
    padding: 20,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: theme.balanced,
    gap: 6,
  },
  emoji: { fontSize: 40 },
  title: { color: theme.balanced, fontSize: 24, fontWeight: '800' },
  subtitle: { color: theme.textDim, fontSize: 14, textAlign: 'center' },
  button: {
    marginTop: 10,
    backgroundColor: theme.balanced,
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 24,
  },
  buttonText: { color: theme.bg, fontWeight: '800', fontSize: 15 },
});
