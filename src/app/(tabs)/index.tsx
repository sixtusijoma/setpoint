import { SetpointDial } from '@/components/dial';
import { Banner, CircleButton, ConfirmDialog, PillButton, Sheet, Stepper } from '@/components/ui';
import { displayBatteries, lowBatterySentence } from '@/domain/batteryFetch';
import { co2Band } from '@/domain/co2';
import { refusalFor, resolveActive } from '@/domain/modeSetpoint';
import { commandLocks, commandProgressCopy } from '@/domain/pendingTarget';
import { planSetTo } from '@/domain/planSetTo';
import { chipFor, currentTarget, nextOccurrence } from '@/domain/schedule';
import { formatRoom, setpointAccent } from '@/domain/temperature';
import { formatInstant, formatStamp } from '@/domain/time';
import { ROOM_CAPTION, TOKEN_PATH } from '@/copy';
import { refreshSpinner } from '@/domain/refresh';
import { openDraft, pickMode, planRecalibrate, unknownModeNote, type RecalibrateDraft } from '@/domain/recalibrateDraft';
import { modeLabel } from '@/domain/systemMode';
import { suggestedTarget, useApp } from '@/state/store';
import { accentColor, colors, fonts, toneColor } from '@/theme';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export default function HomeScreen() {
  const app = useApp();
  const insets = useSafeAreaInsets();
  const setpoint = app.state.virtualSetpoint ?? 0;
  const reading = app.state.mode === 'demo' ? app.state.demoClimate : app.state.lastLive;
  const room = reading?.temperatureF ?? null;
  const accent = accentColor(setpointAccent(setpoint, room ?? setpoint));
  const next = nextOccurrence(app.state.events, app.clock);
  const activeTarget = currentTarget(app.state.events, app.clock);
  const locks = commandLocks({
    commandVisible: app.command !== null,
    desired: app.desiredSetpoint,
    queued: app.queuedTarget !== null || app.queuedMode !== null,
  });
  const progressCopy = app.command
    ? commandProgressCopy({
        commandKind: app.command.kind ?? 'setpoint',
        commandSystemMode: app.command.systemMode,
        commandTarget: app.command.target,
        desiredSetpoint: app.desiredSetpoint,
        queuedTarget: app.queuedTarget,
        queuedMode: app.queuedMode,
      })
    : null;
  const busy = locks.replacements;
  const ratio = app.command
    ? app.command.index / app.command.total
    : (setpoint - app.state.settings.minF) / Math.max(1, app.state.settings.maxF - app.state.settings.minF);
  const [setToOpen, setSetToOpen] = useState(false);
  const [recalOpen, setRecalOpen] = useState(false);
  const [recalError, setRecalError] = useState<string | null>(null);
  const [recalSaving, setRecalSaving] = useState(false);
  const [draft, setDraft] = useState(setpoint);
  const [recal, setRecal] = useState<RecalibrateDraft>({ mode: null, degrees: setpoint });
  const [recalNote, setRecalNote] = useState<string | null>(null);
  const [resumeOpen, setResumeOpen] = useState(false);
  const pullStart = useRef<number | null>(null);
  const atTop = useRef(true);
  const lastPull = useRef(0);
  const scroller = useRef<{ getScrollableNode?: () => EventTarget | null } | null>(null);
  const refreshRef = useRef(app.refreshClimate);
  refreshRef.current = app.refreshClimate;

  function finishPull(pageY: number) {
    if (pullStart.current === null) {
      return;
    }
    const delta = pageY - pullStart.current;
    pullStart.current = null;
    if (!atTop.current || delta <= 72) {
      return;
    }
    const now = Date.now();
    if (now - lastPull.current < 700) {
      return;
    }
    lastPull.current = now;
    void refreshRef.current('user');
  }

  useEffect(() => {
    if (Platform.OS !== 'web') {
      return;
    }
    const host = scroller.current as unknown as {
      getScrollableNode?: () => EventTarget | null;
      addEventListener?: EventTarget['addEventListener'];
    } | null;
    const node = host?.getScrollableNode?.() ?? (host && host.addEventListener ? host : null);
    if (!node || !('addEventListener' in node)) {
      return;
    }
    const target = node as EventTarget;
    const onTouchStart = (event: Event) => {
      const touch = (event as TouchEvent).touches[0];
      if (touch) {
        pullStart.current = touch.pageY;
      }
    };
    const onTouchEnd = (event: Event) => {
      const touch = (event as TouchEvent).changedTouches[0];
      if (touch) {
        finishPull(touch.pageY);
      }
    };
    const onMouseDown = (event: Event) => {
      pullStart.current = (event as MouseEvent).pageY;
    };
    const onMouseUp = (event: Event) => {
      finishPull((event as MouseEvent).pageY);
    };
    target.addEventListener('touchstart', onTouchStart, { passive: true });
    target.addEventListener('touchend', onTouchEnd);
    target.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      target.removeEventListener('touchstart', onTouchStart);
      target.removeEventListener('touchend', onTouchEnd);
      target.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, []);

  const activeSetpoint = resolveActive(app.state.systemMode, {
    heat: app.state.heatSetpoint,
    cool: app.state.coolSetpoint,
  });
  const plan =
    activeSetpoint.status === 'active'
      ? planSetTo({
          current: activeSetpoint.degrees,
          target: draft,
          step: app.state.settings.step,
          minF: app.state.settings.minF,
          maxF: app.state.settings.maxF,
          pressCap: app.state.settings.pressCap,
          wakeFirst: app.state.settings.wakeFirst,
        })
      : { ok: false as const, reason: refusalFor(activeSetpoint) ?? 'Set the virtual setpoint first.' };

  function openSetTo() {
    setDraft(suggestedTarget(app.state));
    setSetToOpen(true);
  }

  const recalContext = {
    systemMode: app.state.systemMode,
    heatSetpoint: app.state.heatSetpoint,
    coolSetpoint: app.state.coolSetpoint,
    fallbackDegrees: app.state.virtualSetpoint ?? app.state.heatSetpoint ?? app.state.coolSetpoint ?? 70,
  };

  function openRecalibrate(note: string | null = null) {
    setRecal(openDraft(recalContext));
    setRecalNote(note);
    setRecalError(null);
    setRecalOpen(true);
  }

  async function saveRecalibrate() {
    const plan = planRecalibrate(recal, recalContext);
    if (!plan.ok) {
      setRecalError(plan.reason);
      return;
    }
    setRecalSaving(true);
    let reason: string | null = null;
    if (plan.setMode) {
      reason = await app.recalibrateSystemMode(plan.setMode);
    }
    if (!reason && plan.setDegrees !== null) {
      reason = await app.recalibrate(plan.setDegrees);
    }
    setRecalSaving(false);
    setRecalError(reason);
    if (!reason) {
      setRecalOpen(false);
    }
  }

  const dialValue = app.state.systemMode === 'off' ? 'Off' : app.state.virtualSetpoint === null ? '—' : app.state.virtualSetpoint;
  const dialCaption =
    app.state.systemMode === 'heat'
      ? 'Heat setpoint'
      : app.state.systemMode === 'cool'
        ? 'Cool setpoint'
        : app.state.systemMode === 'off'
          ? 'Off'
          : 'Mode unknown';
  const batteries = displayBatteries(app.state);
  const batteryWarning = lowBatterySentence(batteries);
  const band = reading ? co2Band(reading.co2Ppm) : null;
  const chip =
    app.state.virtualSetpoint === null
      ? app.state.hold
        ? { kind: 'holding' as const, text: 'Holding. There is no active setpoint until Heat or Cool is on.' }
        : { kind: 'following' as const, text: 'Schedule waits until Heat or Cool is on.' }
      : chipFor({
          setpoint: app.state.virtualSetpoint,
          hold: app.state.hold,
          events: app.state.events,
          records: app.state.records,
          now: app.clock,
        });

  const pulling = refreshSpinner(app.refresh);

  return (
    <ScrollView
      ref={(node) => {
        scroller.current = node as unknown as { getScrollableNode?: () => EventTarget | null } | null;
      }}
      style={styles.screen}
      contentContainerStyle={[styles.content, { paddingTop: Math.max(insets.top, 12) }]}
      refreshControl={
        <RefreshControl
          refreshing={pulling}
          onRefresh={() => {
            void app.refreshClimate('user');
          }}
          tintColor={colors.text}
        />
      }
      scrollEventThrottle={16}
      onScroll={(event) => {
        atTop.current = event.nativeEvent.contentOffset.y <= 4;
      }}
      onTouchStart={(event) => {
        pullStart.current = event.nativeEvent.pageY;
      }}
      onTouchEnd={(event) => {
        finishPull(event.nativeEvent.pageY);
      }}
    >
      {Platform.OS === 'web' && pulling ? (
        <View pointerEvents="none" testID="refresh-spinner" style={styles.pullSpinner}>
          <ActivityIndicator color={colors.text} />
        </View>
      ) : null}
      <View style={styles.header} testID={`home-refresh-${app.refresh}`}>
        <View>
          <Text style={styles.kicker}>
            {app.state.mode === 'demo' ? 'Demo' : 'Live'} · {app.state.roomLabel}
          </Text>
        </View>
        <Pressable
          testID="recalibrate"
          disabled={busy}
          onPress={() => openRecalibrate()}
          style={[styles.recal, busy && styles.dim]}
          accessibilityRole="button"
        >
          <Text style={styles.recalText}>Recalibrate</Text>
        </Pressable>
      </View>

      <View
        testID="hold-chip"
        style={[styles.hold, chip.kind === 'holding' ? styles.holdActive : null, chip.kind === 'off-schedule' ? styles.holdOff : null]}
      >
        <Text testID="hold-text" style={styles.holdText}>
          {chip.text}
        </Text>
        {chip.kind === 'holding' ? (
          <Pressable
            testID="resume-schedule"
            onPress={() => {
              if (activeTarget && app.state.virtualSetpoint !== null && activeTarget.targetF !== app.state.virtualSetpoint) {
                setResumeOpen(true);
                return;
              }
              void app.resumeSchedule();
            }}
          >
            <Text style={styles.resume}>Resume</Text>
          </Pressable>
        ) : null}
        {chip.kind === 'off-schedule' ? (
          <Pressable
            testID="retry-schedule"
            disabled={busy}
            onPress={() => {
              void app.retrySchedule();
            }}
          >
            <Text style={styles.resume}>Retry</Text>
          </Pressable>
        ) : null}
      </View>
      {app.state.catchupNote ? (
        <Text testID="catchup-note" style={styles.note}>
          {app.state.catchupNote}
        </Text>
      ) : null}

      {app.banner ? <Banner message={app.banner} onDismiss={app.clearBanner} /> : null}
      {batteryWarning ? (
        <Text testID="low-battery" style={styles.warning}>
          {batteryWarning}
        </Text>
      ) : null}

      {app.state.mode === 'live' && !app.hasCredentials ? (
        <View style={styles.notice}>
          <Text style={styles.noticeTitle}>SwitchBot credentials are missing</Text>
          <Text style={styles.noticeBody}>{TOKEN_PATH}</Text>
        </View>
      ) : null}
      {app.state.mode === 'live' && app.hasCredentials && (!app.state.deviceMap.up || !app.state.deviceMap.down) ? (
        <View style={styles.notice}>
          <Text style={styles.noticeTitle}>Bots are not mapped</Text>
          <Text style={styles.noticeBody}>Choose the up bot and the down bot in Settings. A hub with cloud service has to be near them.</Text>
        </View>
      ) : null}

      <View style={styles.room}>
        <View style={styles.roomStats}>
          <Stat label="Room" value={room === null ? '-' : `${formatRoom(room)}°`} testID="room-temp" />
          <Stat label="Humidity" value={reading ? `${Math.round(reading.humidity)}%` : '-'} />
          <Stat
            label="CO2"
            value={reading ? `${Math.round(reading.co2Ppm)} ppm` : '-'}
            detail={band?.label ?? '\u00a0'}
            detailColor={band ? toneColor(band.tone) : 'transparent'}
            testID="co2-label"
          />
        </View>
        <Text testID="room-caption" style={styles.caption}>
          {ROOM_CAPTION}
        </Text>
      </View>

      <SetpointDial
        setpoint={dialValue}
        ratio={ratio}
        color={accent}
        caption={dialCaption}
        showDegree={typeof dialValue === 'number'}
      />

      <View style={styles.modeRow}>
        {(['heat', 'off', 'cool'] as const).map((mode) => (
          <Pressable
            key={mode}
            testID={`system-${mode}`}
            disabled={busy}
            onPress={() => {
              if (app.state.systemMode === 'unknown') {
                openRecalibrate(unknownModeNote(mode));
                return;
              }
              void app.setSystemMode(mode);
            }}
            style={[styles.modeItem, app.state.systemMode === mode && styles.modeOn, busy && styles.dim]}
          >
            <Text style={styles.modeText}>{modeLabel(mode)}</Text>
          </Pressable>
        ))}
      </View>
      {app.state.systemMode === 'unknown' ? (
        <Text testID="mode-unknown" style={styles.modeHint}>
          Mode is unknown. Tap Recalibrate and pick the mode the display shows. Setpoint will not press the Mode bot until then.
        </Text>
      ) : null}

      <View style={styles.pads}>
        <CircleButton
          label="−"
          testID="press-down"
          accessibilityLabel="Decrease setpoint"
          disabled={locks.adjustments}
          onPress={() => {
            void app.bump(-1);
          }}
        />
        <CircleButton
          label="+"
          testID="press-up"
          accessibilityLabel="Increase setpoint"
          disabled={locks.adjustments}
          onPress={() => {
            void app.bump(1);
          }}
        />
      </View>

      {app.command && progressCopy ? (
        <View testID="command-progress" style={styles.progress}>
          <Text testID="command-label" style={styles.progressTitle}>
            {app.command.label === 'finishing'
              ? 'Finishing the current press'
              : `Press ${app.command.index} of ${app.command.total}`}
          </Text>
          <View style={styles.track}>
            <View
              style={[
                styles.fill,
                { width: `${Math.min(100, (app.command.index / app.command.total) * 100)}%`, backgroundColor: accent },
              ]}
            />
          </View>
          <Text testID="command-target" style={styles.progressBody}>
            {progressCopy.primary}
          </Text>
          {progressCopy.queued ? (
            <Text testID="command-queued" style={styles.progressQueued}>
              {progressCopy.queued}
            </Text>
          ) : null}
          <PillButton label="Cancel" testID="cancel-command" tone="ghost" onPress={app.cancelCommand} />
        </View>
      ) : (
        <PillButton label="Set to…" testID="set-to" disabled={busy} onPress={openSetTo} />
      )}

      <View style={styles.presets}>
        {app.state.presets.map((preset) => (
          <Pressable
            key={preset.id}
            testID={`preset-${preset.id}`}
            disabled={busy}
            onPress={() => {
              void app.applyPreset(preset);
            }}
            style={[styles.preset, preset.tempF === setpoint && styles.presetOn, busy && styles.dim]}
          >
            <Text style={styles.presetLabel}>{preset.label}</Text>
            <Text style={styles.presetTemp}>{preset.tempF}°</Text>
          </Pressable>
        ))}
      </View>

      <View testID="next-change" style={styles.next}>
        <Text style={styles.kicker}>Next</Text>
        {next ? (
          <Text style={styles.nextText}>
            {next.label} · {formatInstant(next.at)} · {next.targetF}°
          </Text>
        ) : (
          <Text style={styles.nextText}>Nothing scheduled</Text>
        )}
      </View>

      <Text testID="updated-at" style={styles.meta}>
        Up bot {battery(batteries.up)} · Down bot {battery(batteries.down)} · Mode bot {battery(batteries.mode)} · Meter{' '}
        {battery(reading?.batteryMeter)}
        {'\n'}
        Updated {reading ? formatStamp(reading.updatedAt) : '-'}
      </Text>

      <Sheet visible={setToOpen} onClose={() => setSetToOpen(false)}>
        <Text style={styles.sheetTitle}>Set to</Text>
        <Stepper
          testID="set-to-value"
          value={`${draft}°`}
          onMinus={() => setDraft((value) => Math.max(app.state.settings.minF, value - app.state.settings.step))}
          onPlus={() => setDraft((value) => Math.min(app.state.settings.maxF, value + app.state.settings.step))}
        />
        <Text style={styles.sheetBody}>
          {plan.ok
            ? plan.totalPresses === 0
              ? `Already at ${draft}°. No presses would be sent.`
              : `${plan.totalPresses} press${plan.totalPresses === 1 ? '' : 'es'} from ${setpoint}°.`
            : plan.reason}
        </Text>
        {app.state.settings.wakeFirst && plan.ok && plan.totalPresses > 0 ? (
          <Text style={styles.sheetBody}>Includes one wake press that does not change the temperature.</Text>
        ) : null}
        <PillButton
          label="Confirm"
          testID="set-to-confirm"
          disabled={!plan.ok || plan.totalPresses === 0}
          onPress={() => {
            setSetToOpen(false);
            void app.setTo(draft);
          }}
        />
      </Sheet>

      <Sheet visible={recalOpen} onClose={() => setRecalOpen(false)}>
        <Text style={styles.sheetTitle}>Recalibrate</Text>
        <Text style={styles.sheetBody}>
          What does the thermostat display show right now? Saving records it. It does not press any buttons.
        </Text>
        {recalNote ? (
          <Text testID="recalibrate-note" style={[styles.sheetBody, styles.recalNote]}>
            {recalNote}
          </Text>
        ) : null}
        <Text style={styles.sheetLabel}>Mode</Text>
        <View style={styles.modeRow}>
          {(['heat', 'off', 'cool'] as const).map((mode) => (
            <Pressable
              key={`recal-${mode}`}
              testID={`recalibrate-mode-${mode}`}
              accessibilityRole="button"
              accessibilityState={{ selected: recal.mode === mode }}
              onPress={() => {
                setRecalError(null);
                setRecal((draft) => pickMode(draft, mode, recalContext));
              }}
              style={[styles.modeItem, recal.mode === mode && styles.modeOn]}
            >
              <Text style={styles.modeText}>{modeLabel(mode)}</Text>
            </Pressable>
          ))}
        </View>
        {recal.mode === 'heat' || recal.mode === 'cool' ? (
          <>
            <Text style={styles.sheetLabel}>{recal.mode === 'heat' ? 'Heat setpoint' : 'Cool setpoint'}</Text>
            <Stepper
              testID="recalibrate-value"
              value={`${recal.degrees}°`}
              onMinus={() => setRecal((draft) => ({ ...draft, degrees: Math.max(app.state.settings.minF, draft.degrees - 1) }))}
              onPlus={() => setRecal((draft) => ({ ...draft, degrees: Math.min(app.state.settings.maxF, draft.degrees + 1) }))}
            />
          </>
        ) : recal.mode === 'off' ? (
          <Text testID="recalibrate-off" style={styles.sheetBody}>
            Off has no setpoint.
          </Text>
        ) : null}
        {recalError ? (
          <Text testID="recalibrate-error" style={[styles.sheetBody, styles.recalError]}>
            {recalError}
          </Text>
        ) : null}
        <PillButton
          label={recalSaving ? 'Saving…' : 'Save'}
          testID="recalibrate-save"
          disabled={recalSaving}
          onPress={() => {
            void saveRecalibrate();
          }}
        />
      </Sheet>

      <ConfirmDialog
        visible={resumeOpen}
        title="Resume the schedule?"
        body={
          activeTarget
            ? `The schedule is on ${activeTarget.label} at ${activeTarget.targetF}°. Setpoint is ${setpoint}°. Resume and set to ${activeTarget.targetF}°?`
            : 'Resume and follow the schedule?'
        }
        confirmLabel={activeTarget ? `Set to ${activeTarget.targetF}°` : 'Resume'}
        onClose={() => setResumeOpen(false)}
        onConfirm={() => {
          setResumeOpen(false);
          void app.resumeSchedule();
        }}
      />
    </ScrollView>
  );
}

function battery(value: number | null | undefined): string {
  if (typeof value !== 'number') {
    return '-';
  }
  return `${Math.round(value)}%`;
}

function Stat({
  label,
  value,
  detail,
  detailColor,
  testID,
}: {
  label: string;
  value: string;
  detail?: string;
  detailColor?: string;
  testID?: string;
}) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text testID={testID} style={styles.statValue}>
        {value}
      </Text>
      {detail ? <Text style={[styles.statDetail, { color: detailColor }]}>{detail}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  pullSpinner: {
    position: 'absolute',
    top: 8,
    left: 0,
    right: 0,
    alignItems: 'center',
    zIndex: 2,
  },
  content: {
    paddingHorizontal: 20,
    paddingBottom: 40,
    gap: 14,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  kicker: {
    color: colors.muted,
    fontFamily: fonts.medium,
    fontSize: 12,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
  recal: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: 12,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.line,
  },
  recalText: {
    color: colors.text,
    fontFamily: fonts.medium,
    fontSize: 14,
  },
  hold: {
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: colors.card,
    gap: 6,
  },
  holdActive: {
    backgroundColor: 'rgba(255,122,69,0.12)',
  },
  holdOff: {
    backgroundColor: 'rgba(228,210,176,0.12)',
  },
  note: {
    color: colors.neutral,
    fontFamily: fonts.body,
    fontSize: 14,
    lineHeight: 20,
  },
  holdText: {
    color: colors.text,
    fontFamily: fonts.medium,
    fontSize: 14,
  },
  resume: {
    color: colors.coral,
    fontFamily: fonts.semibold,
    fontSize: 14,
  },
  notice: {
    backgroundColor: colors.card,
    borderRadius: 16,
    padding: 14,
    gap: 6,
  },
  noticeTitle: {
    color: colors.text,
    fontFamily: fonts.semibold,
    fontSize: 15,
  },
  noticeBody: {
    color: colors.muted,
    fontFamily: fonts.body,
    fontSize: 13,
    lineHeight: 18,
  },
  room: {
    gap: 6,
  },
  roomStats: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 8,
  },
  stat: {
    flex: 1,
    gap: 2,
  },
  statLabel: {
    color: colors.faint,
    fontFamily: fonts.medium,
    fontSize: 11,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  statValue: {
    color: colors.text,
    fontFamily: fonts.medium,
    fontSize: 20,
    fontVariant: ['tabular-nums'],
  },
  statDetail: {
    fontFamily: fonts.semibold,
    fontSize: 13,
  },
  caption: {
    color: colors.muted,
    fontFamily: fonts.body,
    fontSize: 13,
  },
  pads: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 36,
    marginTop: -8,
  },
  progress: {
    gap: 8,
  },
  progressTitle: {
    color: colors.text,
    fontFamily: fonts.semibold,
    fontSize: 18,
    textAlign: 'center',
  },
  progressBody: {
    color: colors.muted,
    fontFamily: fonts.body,
    textAlign: 'center',
  },
  progressQueued: {
    color: colors.text,
    fontFamily: fonts.medium,
    fontSize: 14,
    textAlign: 'center',
  },
  track: {
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.raised,
    overflow: 'hidden',
  },
  fill: {
    height: 6,
  },
  warning: {
    color: colors.poor,
    fontFamily: fonts.medium,
    fontSize: 14,
    lineHeight: 20,
  },
  modeRow: {
    flexDirection: 'row',
    gap: 8,
  },
  modeItem: {
    flex: 1,
    minHeight: 44,
    borderRadius: 12,
    backgroundColor: colors.card,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modeOn: {
    borderWidth: 1,
    borderColor: colors.neutral,
  },
  modeText: {
    color: colors.text,
    fontFamily: fonts.medium,
    fontSize: 15,
  },
  modeHint: {
    color: colors.muted,
    fontFamily: fonts.body,
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'center',
  },
  presets: {
    flexDirection: 'row',
    gap: 8,
  },
  preset: {
    flex: 1,
    backgroundColor: colors.card,
    borderRadius: 14,
    paddingVertical: 8,
    alignItems: 'center',
    minHeight: 52,
    justifyContent: 'center',
  },
  presetOn: {
    borderWidth: 1,
    borderColor: colors.neutral,
  },
  presetLabel: {
    color: colors.muted,
    fontFamily: fonts.medium,
    fontSize: 12,
  },
  presetTemp: {
    color: colors.text,
    fontFamily: fonts.semibold,
    fontSize: 14,
  },
  dim: {
    opacity: 0.35,
  },
  next: {
    backgroundColor: colors.card,
    borderRadius: 16,
    padding: 14,
    gap: 4,
  },
  nextText: {
    color: colors.text,
    fontFamily: fonts.semibold,
    fontSize: 18,
  },
  meta: {
    color: colors.faint,
    fontFamily: fonts.body,
    fontSize: 12,
    lineHeight: 18,
    textAlign: 'center',
  },
  sheetTitle: {
    color: colors.text,
    fontFamily: fonts.displayStrong,
    fontSize: 32,
  },
  sheetBody: {
    color: colors.muted,
    fontFamily: fonts.body,
    fontSize: 15,
    lineHeight: 21,
  },
  recalError: {
    color: colors.poor,
  },
  recalNote: {
    color: colors.text,
  },
  sheetLabel: {
    color: colors.muted,
    fontFamily: fonts.body,
    fontSize: 12,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
});
