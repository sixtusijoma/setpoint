import { AppKeyScreen } from '@/components/app-key-screen';
import { AppProvider, useApp } from '@/state/store';
import { colors, fonts } from '@/theme';
import {
  Fraunces_500Medium,
  Fraunces_600SemiBold,
} from '@expo-google-fonts/fraunces';
import {
  Outfit_400Regular,
  Outfit_500Medium,
  Outfit_600SemiBold,
} from '@expo-google-fonts/outfit';
import { useFonts } from 'expo-font';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import '../global.css';

SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    Fraunces_500Medium,
    Fraunces_600SemiBold,
    Outfit_400Regular,
    Outfit_500Medium,
    Outfit_600SemiBold,
  });
  return (
    <SafeAreaProvider>
      <AppProvider>
        <StatusBar style="light" />
        <Frame fontsReady={fontsLoaded || Boolean(fontError)} />
      </AppProvider>
    </SafeAreaProvider>
  );
}

function Frame({ fontsReady }: { fontsReady: boolean }) {
  const { ready, state, access, serverConfigured } = useApp();
  const open = ready && fontsReady;
  const needsKey = serverConfigured && access.status !== 'unlocked';
  useEffect(() => {
    if (open) {
      void SplashScreen.hideAsync();
    }
  }, [open]);
  let body = <Boot fontsReady={fontsReady} />;
  if (open && needsKey) {
    body = <AppKeyScreen />;
  } else if (open) {
    body = <RootStack hasSetpoint={state.virtualSetpoint !== null} />;
  }
  return (
    <View style={styles.outer}>
      <View style={styles.column}>{body}</View>
    </View>
  );
}

function RootStack({ hasSetpoint }: { hasSetpoint: boolean }) {
  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }}>
      <Stack.Protected guard={!hasSetpoint}>
        <Stack.Screen name="onboarding" />
      </Stack.Protected>
      <Stack.Protected guard={hasSetpoint}>
        <Stack.Screen name="(tabs)" />
      </Stack.Protected>
    </Stack>
  );
}

function Boot({ fontsReady }: { fontsReady: boolean }) {
  return (
    <View style={styles.boot}>
      <Text style={[styles.word, fontsReady ? styles.wordFont : null]}>Setpoint</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  outer: {
    flex: 1,
    backgroundColor: colors.outer,
    alignItems: 'center',
  },
  column: {
    flex: 1,
    width: '100%',
    maxWidth: 480,
    backgroundColor: colors.bg,
  },
  boot: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bg,
  },
  word: {
    color: colors.text,
    fontSize: 42,
    fontFamily: 'Georgia',
  },
  wordFont: {
    fontFamily: fonts.display,
  },
});
