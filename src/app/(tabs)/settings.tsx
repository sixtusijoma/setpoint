import { PillButton, Sheet, Stepper } from '@/components/ui';
import { HUB_COPY, TOKEN_PATH, WAKE_HELP, WEB_SECRET_COPY } from '@/copy';
import { deviceNotes, type SwitchBotDevice } from '@/devices/switchbot';
import type { Co2Tone } from '@/domain/co2';
import { PRESS_SPACING_MS } from '@/domain/pressSession';
import { useApp } from '@/state/store';
import { colors, fonts } from '@/theme';
import { useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export default function SettingsScreen() {
  const app = useApp();
  const insets = useSafeAreaInsets();
  const [token, setToken] = useState('');
  const [secret, setSecret] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [recalOpen, setRecalOpen] = useState(false);
  const [recalError, setRecalError] = useState<string | null>(null);
  const [recalSaving, setRecalSaving] = useState(false);
  const [recal, setRecal] = useState(app.state.virtualSetpoint ?? 70);
  const settings = app.state.settings;
  const outside =
    app.state.virtualSetpoint !== null &&
    (app.state.virtualSetpoint < settings.minF || app.state.virtualSetpoint > settings.maxF);

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={[styles.content, { paddingTop: Math.max(insets.top, 16), paddingBottom: 96 }]}
      keyboardShouldPersistTaps="handled"
    >
      <Text style={styles.title}>Settings</Text>

      <Text style={styles.section}>Mode</Text>
      <View style={styles.segment}>
        <Pressable
          testID="mode-demo"
          style={[styles.segmentItem, app.state.mode === 'demo' && styles.segmentOn]}
          onPress={() => app.setMode('demo')}
        >
          <Text style={styles.segmentText}>Demo</Text>
        </Pressable>
        <Pressable
          testID="mode-live"
          style={[styles.segmentItem, app.state.mode === 'live' && styles.segmentOn]}
          onPress={() => app.setMode('live')}
        >
          <Text style={styles.segmentText}>Live</Text>
        </Pressable>
      </View>

      {app.serverConfigured ? (
        <View style={styles.block}>
          <Text style={styles.section}>App key</Text>
          <Text style={styles.body}>
            The key stays in the secure store on this phone. It is not part of the app build. Change it here, or clear it and enter a new one.
          </Text>
          <PillButton label="Change key" testID="app-key-change" onPress={app.changeAppKey} />
          <PillButton label="Clear key" tone="ghost" testID="app-key-clear" onPress={() => void app.clearAppKey()} />
        </View>
      ) : null}

      {app.state.mode === 'demo' ? (
        <View style={styles.block}>
          <Text style={styles.section}>Simulated room</Text>
          <Text style={styles.body}>CO2 color bands. Pull to refresh on Home drifts the room without touching the setpoint.</Text>
          <View style={styles.segment}>
            <Band label="Good" tone="good" onPress={() => app.setCo2Band('good')} />
            <Band label="Moderate" tone="moderate" onPress={() => app.setCo2Band('moderate')} />
            <Band label="Poor" tone="poor" onPress={() => app.setCo2Band('poor')} />
          </View>
          <View style={styles.row}>
            <Text style={styles.body}>Fail the next press</Text>
            <Switch
              testID="fail-next"
              value={app.state.demoClimate.failNextPress}
              onValueChange={app.setFailNext}
              trackColor={{ false: colors.raised, true: colors.poor }}
              thumbColor={colors.text}
            />
          </View>
          <View style={styles.row}>
            <Text style={styles.body}>Lose the next response</Text>
            <Switch
              testID="lose-next"
              value={app.state.demoClimate.loseNextResponse}
              onValueChange={app.setLoseNext}
              trackColor={{ false: colors.raised, true: colors.poor }}
              thumbColor={colors.text}
            />
          </View>
          <PillButton label="Reset demo" tone="ghost" testID="reset-demo" onPress={app.resetDemo} />
        </View>
      ) : null}

      <Text style={styles.section}>SwitchBot</Text>
      {Platform.OS === 'web' ? <Text style={styles.body}>{WEB_SECRET_COPY}</Text> : null}
      <Text style={styles.body}>{TOKEN_PATH}</Text>
      <Text style={styles.body}>{HUB_COPY}</Text>
      {app.secretMask ? (
        <Text testID="secret-mask" style={styles.mask}>
          Secret {app.secretMask}
        </Text>
      ) : (
        <Text style={styles.body}>No secret saved</Text>
      )}
      {app.tokenMask ? <Text style={styles.mask}>Token {app.tokenMask}</Text> : null}
      <TextInput
        value={token}
        onChangeText={setToken}
        placeholder="Token"
        placeholderTextColor={colors.faint}
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry
        style={styles.input}
        testID="settings-token"
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
        testID="settings-secret"
      />
      <PillButton
        label="Save and load devices"
        testID="load-devices"
        onPress={() => {
          void (async () => {
            const error = await app.saveAndLoadDevices(token, secret);
            setToken('');
            setSecret('');
            setStatus(error ?? 'Credentials saved. The secret is masked.');
          })();
        }}
      />
      {app.hasCredentials ? (
        <PillButton
          label="Reload devices"
          tone="ghost"
          onPress={() => {
            void (async () => {
              const error = await app.reloadDevices();
              setStatus(error);
            })();
          }}
        />
      ) : null}
      {status ? <Text style={styles.body}>{status}</Text> : null}
      {app.deviceMessage ? <Text style={styles.body}>{app.deviceMessage}</Text> : null}
      {!app.hasCredentials ? (
        <Text style={styles.body}>
          Credentials are missing. Without a token, the device list stays empty and live presses cannot run.
        </Text>
      ) : null}
      <Mapper label="Up bot" selected={app.state.deviceMap.up} devices={app.devices} onPick={(device) => app.mapRole('up', device)} />
      <Mapper
        label="Down bot"
        selected={app.state.deviceMap.down}
        devices={app.devices}
        onPick={(device) => app.mapRole('down', device)}
      />
      <Mapper
        label="Meter"
        selected={app.state.deviceMap.meter}
        devices={app.devices}
        onPick={(device) => app.mapRole('meter', device)}
      />

      <Text style={styles.section}>Thermostat</Text>
      <Adjust
        label="Step"
        value={`${settings.step}°`}
        onMinus={() => app.updateSettings({ step: Math.max(1, settings.step - 1) })}
        onPlus={() => app.updateSettings({ step: Math.min(5, settings.step + 1) })}
      />
      <Adjust
        label="Delay"
        value={`${settings.delayMs} ms`}
        onMinus={() => app.updateSettings({ delayMs: Math.max(250, settings.delayMs - 250) })}
        onPlus={() => app.updateSettings({ delayMs: Math.min(10000, settings.delayMs + 250) })}
      />
      <Text style={styles.body}>
        {`Presses wait at least ${PRESS_SPACING_MS.down / 1000} s going down and ${PRESS_SPACING_MS.up / 1000} s going up so the thermostat catches each one. A longer delay here wins.`}
      </Text>
      <Adjust
        label="Minimum"
        value={`${settings.minF}°`}
        onMinus={() => app.updateSettings({ minF: Math.max(40, settings.minF - 1) })}
        onPlus={() => app.updateSettings({ minF: Math.min(settings.maxF - 1, settings.minF + 1) })}
      />
      <Adjust
        label="Maximum"
        value={`${settings.maxF}°`}
        onMinus={() => app.updateSettings({ maxF: Math.max(settings.minF + 1, settings.maxF - 1) })}
        onPlus={() => app.updateSettings({ maxF: Math.min(99, settings.maxF + 1) })}
      />
      <Adjust
        label="Press cap"
        value={`${settings.pressCap}`}
        onMinus={() => app.updateSettings({ pressCap: Math.max(1, settings.pressCap - 1) })}
        onPlus={() => app.updateSettings({ pressCap: Math.min(40, settings.pressCap + 1) })}
      />
      {outside ? (
        <Text style={styles.body}>
          The saved setpoint is outside {settings.minF}–{settings.maxF}°. Widen the range or recalibrate before sending
          presses.
        </Text>
      ) : null}
      <View style={styles.row}>
        <View style={styles.flex}>
          <Text style={styles.rowLabel}>First press only wakes the display</Text>
          <Text style={styles.body}>{WAKE_HELP}</Text>
        </View>
        <Switch
          testID="wake-toggle"
          value={settings.wakeFirst}
          onValueChange={(wakeFirst) => app.updateSettings({ wakeFirst })}
          trackColor={{ false: colors.raised, true: colors.coral }}
          thumbColor={colors.text}
        />
      </View>
      <PillButton
        label="Recalibrate"
        testID="settings-recalibrate"
        onPress={() => {
          setRecal(app.state.virtualSetpoint ?? 70);
          setRecalError(null);
          setRecalOpen(true);
        }}
      />

      <Text style={styles.section}>Room name</Text>
      <TextInput
        value={app.state.roomLabel}
        onChangeText={app.setRoomLabel}
        style={styles.input}
        placeholder="Home"
        placeholderTextColor={colors.faint}
      />

      <Text style={styles.section}>Presets</Text>
      <Text style={styles.body}>Editing a preset does not change the thermostat. Apply it from Home.</Text>
      {app.state.presets.map((preset) => (
        <View key={preset.id} style={styles.preset}>
          <TextInput
            value={preset.label}
            onChangeText={(label) => app.updatePreset(preset.id, { label })}
            style={styles.input}
          />
          <View style={styles.presetTemp}>
            <Pressable
              style={styles.tiny}
              onPress={() => app.updatePreset(preset.id, { tempF: Math.max(settings.minF, preset.tempF - settings.step) })}
            >
              <Text style={styles.tinyText}>−</Text>
            </Pressable>
            <Text style={styles.presetValue}>{preset.tempF}°</Text>
            <Pressable
              style={styles.tiny}
              onPress={() => app.updatePreset(preset.id, { tempF: Math.min(settings.maxF, preset.tempF + settings.step) })}
            >
              <Text style={styles.tinyText}>+</Text>
            </Pressable>
          </View>
        </View>
      ))}

      <Text style={styles.section}>Reminders</Text>
      <Text style={styles.body}>
        Setpoint can remind you when a change is due. Open the app to run it. iOS will not reliably press the bots while
        the app is suspended.
      </Text>
      <PillButton
        label="Allow reminders"
        testID="allow-reminders"
        onPress={() => {
          void (async () => {
            const message = await app.allowReminders();
            setStatus(message);
          })();
        }}
      />

      <Sheet visible={recalOpen} onClose={() => setRecalOpen(false)}>
        <Text style={styles.sheetTitle}>Recalibrate</Text>
        <Text style={styles.body}>
          What does the thermostat display show right now? Saving replaces the virtual setpoint. It does not press any
          buttons.
        </Text>
        <Stepper
          value={`${recal}°`}
          onMinus={() => setRecal((value) => Math.max(settings.minF, value - 1))}
          onPlus={() => setRecal((value) => Math.min(settings.maxF, value + 1))}
        />
        {recalError ? (
          <Text testID="settings-recalibrate-error" style={[styles.body, styles.recalError]}>
            {recalError}
          </Text>
        ) : null}
        <PillButton
          label={recalSaving ? 'Saving…' : 'Save setpoint'}
          testID="settings-recalibrate-save"
          disabled={recalSaving}
          onPress={() => {
            void (async () => {
              setRecalSaving(true);
              const reason = await app.recalibrate(recal);
              setRecalSaving(false);
              setRecalError(reason);
              if (!reason) {
                setRecalOpen(false);
              }
            })();
          }}
        />
      </Sheet>
    </ScrollView>
  );
}

function Band({ label, tone, onPress }: { label: string; tone: Co2Tone; onPress: () => void }) {
  return (
    <Pressable testID={`co2-${tone}`} style={styles.segmentItem} onPress={onPress}>
      <Text style={styles.segmentText}>{label}</Text>
    </Pressable>
  );
}

function Adjust({
  label,
  value,
  onMinus,
  onPlus,
}: {
  label: string;
  value: string;
  onMinus: () => void;
  onPlus: () => void;
}) {
  return (
    <View style={styles.adjust}>
      <Text style={styles.rowLabel}>{label}</Text>
      <View style={styles.presetTemp}>
        <Pressable style={styles.tiny} onPress={onMinus} accessibilityLabel={`Decrease ${label}`}>
          <Text style={styles.tinyText}>−</Text>
        </Pressable>
        <Text style={styles.presetValue}>{value}</Text>
        <Pressable style={styles.tiny} onPress={onPlus} accessibilityLabel={`Increase ${label}`}>
          <Text style={styles.tinyText}>+</Text>
        </Pressable>
      </View>
    </View>
  );
}

function Mapper({
  label,
  selected,
  devices,
  onPick,
}: {
  label: string;
  selected: { name: string; enableCloudService: boolean | null; hubDeviceId: string } | null;
  devices: SwitchBotDevice[];
  onPick: (device: SwitchBotDevice) => void;
}) {
  const notes = selected
    ? deviceNotes({
        deviceName: selected.name,
        enableCloudService: selected.enableCloudService,
        hubDeviceId: selected.hubDeviceId,
      })
    : [];
  return (
    <View style={styles.block}>
      <Text style={styles.rowLabel}>
        {label} · {selected?.name ?? 'Not mapped'}
      </Text>
      {notes.map((note) => (
        <Text key={note} style={styles.body}>
          {note}
        </Text>
      ))}
      {devices.map((device) => (
        <Pressable key={`${label}-${device.deviceId}`} style={styles.device} onPress={() => onPick(device)}>
          <Text style={styles.deviceText}>
            {device.deviceName} · {device.deviceType}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { paddingHorizontal: 20, gap: 12 },
  title: { color: colors.text, fontFamily: fonts.displayStrong, fontSize: 36 },
  section: { color: colors.text, fontFamily: fonts.semibold, fontSize: 18, marginTop: 8 },
  body: { color: colors.muted, fontFamily: fonts.body, fontSize: 14, lineHeight: 20 },
  mask: { color: colors.text, fontFamily: fonts.medium, fontSize: 16 },
  input: {
    backgroundColor: colors.card,
    color: colors.text,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 12,
    fontFamily: fonts.body,
    fontSize: 16,
  },
  segment: { flexDirection: 'row', gap: 8 },
  segmentItem: {
    flex: 1,
    minHeight: 44,
    borderRadius: 12,
    backgroundColor: colors.card,
    alignItems: 'center',
    justifyContent: 'center',
  },
  segmentOn: { backgroundColor: colors.raised, borderWidth: 1, borderColor: colors.neutral },
  segmentText: { color: colors.text, fontFamily: fonts.medium, fontSize: 14 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  flex: { flex: 1, gap: 4 },
  rowLabel: { color: colors.text, fontFamily: fonts.medium, fontSize: 15 },
  block: { gap: 8 },
  adjust: { gap: 6 },
  preset: { gap: 8, backgroundColor: colors.card, borderRadius: 16, padding: 12 },
  presetTemp: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  presetValue: { color: colors.text, fontFamily: fonts.semibold, fontSize: 18, fontVariant: ['tabular-nums'] },
  tiny: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.raised,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tinyText: { color: colors.text, fontSize: 22 },
  device: { backgroundColor: colors.card, borderRadius: 12, padding: 12 },
  deviceText: { color: colors.text, fontFamily: fonts.medium, fontSize: 14 },
  sheetTitle: { color: colors.text, fontFamily: fonts.displayStrong, fontSize: 28 },
  recalError: { color: colors.poor },
});
