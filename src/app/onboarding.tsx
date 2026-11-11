import { HUB_COPY, TOKEN_PATH, WEB_SECRET_COPY } from '@/copy';
import { deviceNotes, type SwitchBotDevice } from '@/devices/switchbot';
import { useApp } from '@/state/store';
import { colors, fonts } from '@/theme';
import { PillButton, Stepper } from '@/components/ui';
import { useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

type Step = 'intro' | 'connect' | 'map' | 'calibrate';

export default function OnboardingScreen() {
  const app = useApp();
  const insets = useSafeAreaInsets();
  const [step, setStep] = useState<Step>('intro');
  const [token, setToken] = useState('');
  const [secret, setSecret] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [temperature, setTemperature] = useState(70);

  async function loadDevices() {
    setBusy(true);
    const error = await app.saveAndLoadDevices(token, secret);
    setBusy(false);
    setToken('');
    setSecret('');
    setMessage(error);
    setStep('map');
  }

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={[styles.content, { paddingTop: Math.max(insets.top, 20), paddingBottom: 32 }]}
    >
      {step === 'intro' ? (
        <View style={styles.block}>
          <Text style={styles.kicker}>Setpoint</Text>
          <Text style={styles.title}>The display is the setpoint.</Text>
          <Text style={styles.body}>
            Setpoint remembers the number on the thermostat, not the air in the room. Each press of the up or down bot
            changes that virtual setpoint by one step. It never waits for the room to catch up, and it never copies the
            sensor into the setpoint.
          </Text>
          <Text style={styles.body}>
            You enter the number on the display once. After that, opening the app goes straight to the thermostat.
            Recalibrate later only if someone presses the physical buttons.
          </Text>
          <PillButton
            label="Try the demo"
            testID="onboarding-demo"
            onPress={() => {
              app.setMode('demo');
              setStep('calibrate');
            }}
          />
          <PillButton
            label="Connect SwitchBot"
            tone="ghost"
            testID="onboarding-connect"
            onPress={() => setStep('connect')}
          />
        </View>
      ) : null}

      {step === 'connect' ? (
        <View style={styles.block}>
          <Pressable onPress={() => setStep('intro')}>
            <Text style={styles.back}>Back</Text>
          </Pressable>
          <Text style={styles.title}>SwitchBot token</Text>
          <Text style={styles.body}>{TOKEN_PATH}</Text>
          <Text style={styles.body}>{HUB_COPY}</Text>
          {Platform.OS === 'web' ? <Text style={styles.note}>{WEB_SECRET_COPY}</Text> : null}
          <TextInput
            value={token}
            onChangeText={setToken}
            placeholder="Token"
            placeholderTextColor={colors.faint}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
            style={styles.input}
            testID="token-input"
          />
          <TextInput
            value={secret}
            onChangeText={setSecret}
            placeholder="Secret"
            placeholderTextColor={colors.faint}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
            style={styles.input}
            testID="secret-input"
          />
          <PillButton
            label={busy ? 'Loading…' : 'Save and load devices'}
            disabled={busy}
            onPress={() => {
              void loadDevices();
            }}
          />
          {message ? <Text style={styles.note}>{message}</Text> : null}
        </View>
      ) : null}

      {step === 'map' ? (
        <View style={styles.block}>
          <Text style={styles.title}>Map the devices</Text>
          <Text style={styles.body}>
            Choose the heat-up bot, the heat-down bot, and the Meter Pro CO2. You can change this later in Settings.
          </Text>
          {message ? <Text style={styles.note}>{message}</Text> : null}
          <RolePicker
            label="Up bot"
            selected={app.state.deviceMap.up?.name ?? 'Not mapped'}
            devices={app.devices}
            onPick={(device) => app.mapRole('up', device)}
          />
          <RolePicker
            label="Down bot"
            selected={app.state.deviceMap.down?.name ?? 'Not mapped'}
            devices={app.devices}
            onPick={(device) => app.mapRole('down', device)}
          />
          <RolePicker
            label="Meter"
            selected={app.state.deviceMap.meter?.name ?? 'Not mapped'}
            devices={app.devices}
            onPick={(device) => app.mapRole('meter', device)}
          />
          <PillButton label="Continue" onPress={() => setStep('calibrate')} />
          <PillButton
            label="Use demo instead"
            tone="ghost"
            onPress={() => {
              app.setMode('demo');
              setStep('calibrate');
            }}
          />
        </View>
      ) : null}

      {step === 'calibrate' ? (
        <View style={styles.block}>
          <Text style={styles.kicker}>Once</Text>
          <Text style={styles.title}>What's on the display?</Text>
          <Text style={styles.body}>
            Read the thermostat. Saving records the virtual setpoint and does not press any buttons. Setpoint keeps this
            number the next time you open the app.
          </Text>
          <Stepper
            testID="calibration-value"
            value={`${temperature}°`}
            onMinus={() => setTemperature((value) => Math.max(app.state.settings.minF, value - 1))}
            onPlus={() => setTemperature((value) => Math.min(app.state.settings.maxF, value + 1))}
            minusLabel="Lower calibration temperature"
            plusLabel="Raise calibration temperature"
          />
          <PillButton
            label="Save setpoint"
            testID="calibration-save"
            onPress={() => app.completeCalibration(temperature)}
          />
        </View>
      ) : null}
    </ScrollView>
  );
}

function RolePicker({
  label,
  selected,
  devices,
  onPick,
}: {
  label: string;
  selected: string;
  devices: SwitchBotDevice[];
  onPick: (device: SwitchBotDevice) => void;
}) {
  return (
    <View style={styles.role}>
      <Text style={styles.roleLabel}>
        {label} · {selected}
      </Text>
      {devices.length === 0 ? <Text style={styles.note}>No devices loaded.</Text> : null}
      {devices.map((device) => {
        const notes = deviceNotes(device);
        return (
          <Pressable key={`${label}-${device.deviceId}`} style={styles.deviceRow} onPress={() => onPick(device)}>
            <Text style={styles.deviceName}>
              {device.deviceName} · {device.deviceType}
            </Text>
            {notes.map((note) => (
              <Text key={note} style={styles.note}>
                {note}
              </Text>
            ))}
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  content: {
    paddingHorizontal: 22,
    gap: 16,
  },
  block: {
    gap: 14,
  },
  kicker: {
    color: colors.neutral,
    fontFamily: fonts.medium,
    letterSpacing: 1.6,
    textTransform: 'uppercase',
    fontSize: 12,
  },
  title: {
    color: colors.text,
    fontFamily: fonts.displayStrong,
    fontSize: 40,
    lineHeight: 44,
  },
  body: {
    color: colors.muted,
    fontFamily: fonts.body,
    fontSize: 16,
    lineHeight: 23,
  },
  note: {
    color: colors.neutral,
    fontFamily: fonts.body,
    fontSize: 14,
    lineHeight: 20,
  },
  back: {
    color: colors.muted,
    fontFamily: fonts.medium,
    fontSize: 15,
  },
  input: {
    backgroundColor: colors.card,
    color: colors.text,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 14,
    fontFamily: fonts.body,
    fontSize: 16,
  },
  tempLabel: {
    color: colors.text,
    fontFamily: fonts.display,
    fontSize: 64,
    textAlign: 'center',
  },
  role: {
    gap: 8,
  },
  roleLabel: {
    color: colors.text,
    fontFamily: fonts.semibold,
    fontSize: 16,
  },
  deviceRow: {
    backgroundColor: colors.card,
    borderRadius: 12,
    padding: 12,
    gap: 4,
  },
  deviceName: {
    color: colors.text,
    fontFamily: fonts.medium,
    fontSize: 15,
  },
});
