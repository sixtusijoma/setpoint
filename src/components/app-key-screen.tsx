import { PillButton } from '@/components/ui';
import { useApp } from '@/state/store';
import { colors, fonts } from '@/theme';
import { useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export function AppKeyScreen() {
  const app = useApp();
  const insets = useSafeAreaInsets();
  const [value, setValue] = useState('');
  const status = app.access.status;
  const checking = status === 'checking';
  const title =
    status === 'wrong-key' ? 'That key was rejected' : checking ? 'Checking the key' : 'Enter the app key';
  const body =
    status === 'wrong-key'
      ? 'The server did not accept that key. Enter it again, or clear the saved key and start over.'
      : checking
        ? 'Setpoint is asking the server whether this key is allowed.'
        : 'This phone needs the app key before it can reach the shared server. The key stays in secure storage on this device.';
  return (
    <View style={[styles.screen, { paddingTop: Math.max(insets.top, 28), paddingBottom: Math.max(insets.bottom, 24) }]}>
      <Text style={styles.kicker}>Shared server</Text>
      <Text style={styles.title}>{title}</Text>
      <Text testID="app-key-status" style={styles.status}>
        {status}
      </Text>
      <Text style={styles.body}>{body}</Text>
      {app.gateNote ? (
        <Text testID="app-key-note" style={styles.note}>
          {app.gateNote}
        </Text>
      ) : null}
      <TextInput
        value={value}
        onChangeText={setValue}
        placeholder="App key"
        placeholderTextColor={colors.faint}
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="off"
        secureTextEntry
        editable={!checking}
        style={styles.input}
        testID="app-key-input"
      />
      <PillButton
        label={checking ? 'Checking' : 'Save key'}
        testID="app-key-save"
        disabled={checking || value.trim().length === 0}
        onPress={() => {
          const next = value;
          setValue('');
          void app.submitAppKey(next);
        }}
      />
      {status === 'locked' || status === 'wrong-key' ? (
        <PillButton
          label="Clear saved key"
          tone="ghost"
          testID="app-key-clear"
          onPress={() => {
            setValue('');
            void app.clearAppKey();
          }}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.bg,
    paddingHorizontal: 24,
    gap: 14,
  },
  kicker: {
    color: colors.faint,
    fontFamily: fonts.medium,
    fontSize: 13,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  title: {
    color: colors.text,
    fontFamily: fonts.display,
    fontSize: 36,
    lineHeight: 42,
  },
  status: {
    color: colors.coral,
    fontFamily: fonts.semibold,
    fontSize: 14,
  },
  body: {
    color: colors.muted,
    fontFamily: fonts.body,
    fontSize: 16,
    lineHeight: 22,
  },
  note: {
    color: colors.text,
    fontFamily: fonts.medium,
    fontSize: 15,
    lineHeight: 21,
  },
  input: {
    backgroundColor: colors.card,
    color: colors.text,
    fontFamily: fonts.body,
    fontSize: 16,
    borderRadius: 14,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
});
