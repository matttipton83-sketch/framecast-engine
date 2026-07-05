import { StatusBar } from 'expo-status-bar';
import React from 'react';
import { Platform, SafeAreaView, StyleSheet } from 'react-native';
import { SAMPLE_PUZZLE } from './src/model/samplePuzzle';
import { GameScreen } from './src/screens/GameScreen';
import { theme } from './src/theme';

export default function App() {
  return (
    <SafeAreaView style={styles.root}>
      <StatusBar style="light" />
      <GameScreen puzzle={SAMPLE_PUZZLE} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: theme.bg,
    // Web has no notch; native gets a bit of top inset from SafeAreaView.
    paddingTop: Platform.OS === 'android' ? 24 : 0,
  },
});
