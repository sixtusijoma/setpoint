import { co2ForBand, type Co2Tone } from '@/domain/co2';
import { executePlan, sleepUnlessCancelled } from '@/domain/execute';
import { nearestTarget, planSetTo } from '@/domain/planSetTo';
import { currentTarget, defaultEvents, nextOccurrence, upsertRecord, type ScheduleEvent } from '@/domain/schedule';
import { runDueSchedule } from '@/domain/scheduleRunner';
import { formatClock, formatInstant } from '@/domain/time';
import { driftClimate, initialClimate } from '@/devices/simulator';
import {
  deviceNotes,
  listDevices,
  pressBot,
  readBotBattery,
  readMeter,
  TransportError,
  type SwitchBotDevice,
} from '@/devices/switchbot';
import { BROWSER_BLOCKED } from '@/copy';
import { errorFeedback, pressFeedback, successFeedback } from '@/haptics';
import { requestReminderPermission, syncReminders, watchNotificationOpen } from '@/notifications/reminders';
import { clearCredentials, loadCredentials, maskSecret, saveCredentials } from '@/storage/credentials';
import { loadPersisted, savePersisted } from '@/storage/persist';
import {
  appendLog,
  createDefaultState,
  createId,
  deviceFromApi,
  type CommandSource,
  type DeviceRef,
  type Persisted,
  type Preset,
} from '@/state/model';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AppState, Platform, type AppStateStatus } from 'react-native';

export type CommandProgress = {
  index: number;
  total: number;
  target: number;
};

export type CommandResult = {
  status: 'done' | 'already' | 'cancelled' | 'failed' | 'refused' | 'busy';
  stoppedAt: number;
  wanted: number;
  reason?: string;
};

type AppContextValue = {
  ready: boolean;
  state: Persisted;
  clock: Date;
  command: CommandProgress | null;
  banner: string | null;
  refreshing: boolean;
  devices: SwitchBotDevice[];
  deviceMessage: string | null;
  hasCredentials: boolean;
  tokenMask: string | null;
  secretMask: string | null;
  clearBanner: () => void;
  setMode: (mode: Persisted['mode']) => void;
  setRoomLabel: (label: string) => void;
  updateSettings: (patch: Partial<Persisted['settings']>) => void;
  saveAndLoadDevices: (token: string, secret: string) => Promise<string | null>;
  reloadDevices: () => Promise<string | null>;
  forgetCredentials: () => Promise<void>;
  mapRole: (role: 'up' | 'down' | 'meter', device: SwitchBotDevice | null) => void;
  completeCalibration: (temp: number) => void;
  recalibrate: (temp: number) => void;
  bump: (direction: 1 | -1) => Promise<void>;
  setTo: (target: number) => Promise<CommandResult>;
  applyPreset: (preset: Preset) => Promise<void>;
  cancelCommand: () => void;
  refreshClimate: () => Promise<void>;
  setCo2Band: (tone: Co2Tone) => void;
  setFailNext: (value: boolean) => void;
  resetDemo: () => void;
  updatePreset: (id: string, patch: Partial<Pick<Preset, 'label' | 'tempF'>>) => void;
  saveEvent: (event: ScheduleEvent) => void;
  addEvent: () => void;
  deleteEvent: (id: string) => void;
  restoreDefaults: () => void;
  resumeSchedule: () => Promise<void>;
  applyCancelled: (key: string) => Promise<void>;
  allowReminders: () => Promise<string>;
};

const AppContext = createContext<AppContextValue | null>(null);

function startsHold(source: CommandSource): boolean {
  return source.kind === 'manual' || source.kind === 'set-to' || source.kind === 'preset';
}

function explainError(error: unknown): string {
  if (Platform.OS === 'web' && (error instanceof TransportError || isFetchFailure(error))) {
    return BROWSER_BLOCKED;
  }
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return 'Something went wrong.';
}

function isFetchFailure(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return /failed to fetch|network request failed|load failed/i.test(error.message);
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<Persisted>(() => createDefaultState(new Date().toISOString()));
  const [ready, setReady] = useState(false);
  const [clock, setClock] = useState(() => new Date());
  const [command, setCommand] = useState<CommandProgress | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [devices, setDevices] = useState<SwitchBotDevice[]>([]);
  const [deviceMessage, setDeviceMessage] = useState<string | null>(null);
  const [hasCredentials, setHasCredentials] = useState(false);
  const [tokenMask, setTokenMask] = useState<string | null>(null);
  const [secretMask, setSecretMask] = useState<string | null>(null);
  const stateRef = useRef(state);
  const cancelRef = useRef(false);
  const runningRef = useRef(false);
  const tickLock = useRef(false);
  const retryArmed = useRef(true);
  const tickImpl = useRef<(now: Date) => Promise<void>>(async () => undefined);

  const commit = useCallback((recipe: (prev: Persisted) => Persisted) => {
    const next = recipe(stateRef.current);
    stateRef.current = next;
    setState(next);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const stored = await loadPersisted(new Date().toISOString());
      const creds = await loadCredentials();
      if (cancelled) {
        return;
      }
      if (stored) {
        let next = stored;
        if (next.virtualSetpoint !== null && !next.catchupFrom) {
          next = { ...next, catchupFrom: new Date().toISOString() };
        }
        stateRef.current = next;
        setState(next);
      }
      if (creds) {
        setHasCredentials(true);
        setTokenMask(maskSecret(creds.token));
        setSecretMask(maskSecret(creds.secret));
      }
      setReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!ready) {
      return;
    }
    void savePersisted(state);
  }, [ready, state]);

  useEffect(() => {
    const timer = setInterval(() => {
      setClock(new Date());
    }, 20000);
    return () => {
      clearInterval(timer);
    };
  }, []);

  const pressRole = useCallback(
    async (direction: 'up' | 'down') => {
      const snapshot = stateRef.current;
      if (snapshot.mode === 'demo') {
        if (snapshot.demoClimate.failNextPress) {
          commit((prev) => ({
            ...prev,
            demoClimate: { ...prev.demoClimate, failNextPress: false },
          }));
          throw new Error(`The ${direction} bot did not respond.`);
        }
        return;
      }
      const creds = await loadCredentials();
      if (!creds) {
        throw new Error('Add a SwitchBot token and secret in Settings.');
      }
      const device = direction === 'up' ? snapshot.deviceMap.up : snapshot.deviceMap.down;
      if (!device) {
        throw new Error(`The ${direction} bot is not mapped.`);
      }
      try {
        await pressBot(creds, device.id);
      } catch (error) {
        throw new Error(explainError(error));
      }
    },
    [commit],
  );

  const runTarget = useCallback(
    async (target: number, source: CommandSource): Promise<CommandResult> => {
      if (runningRef.current) {
        return { status: 'busy', stoppedAt: stateRef.current.virtualSetpoint ?? target, wanted: target, reason: 'A command is already running.' };
      }
      const snapshot = stateRef.current;
      if (snapshot.virtualSetpoint === null) {
        return { status: 'refused', stoppedAt: target, wanted: target, reason: 'Set the virtual setpoint first.' };
      }
      const current = snapshot.virtualSetpoint;
      const plan = planSetTo({
        current,
        target,
        step: snapshot.settings.step,
        minF: snapshot.settings.minF,
        maxF: snapshot.settings.maxF,
        pressCap: snapshot.settings.pressCap,
        wakeFirst: snapshot.settings.wakeFirst,
      });
      if (!plan.ok) {
        if (source.kind !== 'schedule') {
          setBanner(plan.reason);
          errorFeedback();
        }
        return { status: 'refused', stoppedAt: current, wanted: target, reason: plan.reason };
      }
      if (plan.actions.length === 0) {
        if (source.kind !== 'schedule') {
          const at = new Date().toISOString();
          commit((prev) => {
            let next = appendLog(prev, 'schedule', `Already at ${target}°. No presses sent.`, at);
            if (startsHold(source)) {
              next = holdOnto(next, new Date());
            }
            return next;
          });
        }
        return { status: 'already', stoppedAt: current, wanted: target };
      }
      if (snapshot.mode === 'live') {
        const creds = await loadCredentials();
        if (!creds) {
          const reason = 'Add a SwitchBot token and secret in Settings.';
          if (source.kind !== 'schedule') {
            setBanner(reason);
          }
          return { status: 'refused', stoppedAt: current, wanted: target, reason };
        }
        if (!snapshot.deviceMap.up || !snapshot.deviceMap.down) {
          const reason = 'Map the up bot and the down bot in Settings before sending presses.';
          if (source.kind !== 'schedule') {
            setBanner(reason);
          }
          return { status: 'refused', stoppedAt: current, wanted: target, reason };
        }
      }
      runningRef.current = true;
      cancelRef.current = false;
      setCommand({ index: 1, total: plan.actions.length, target });
      if (source.kind !== 'schedule') {
        setBanner(null);
      }
      const result = await executePlan(plan, current, {
        delayMs: snapshot.settings.delayMs,
        sleep: sleepUnlessCancelled,
        isCancelled: () => cancelRef.current,
        pressUp: () => pressRole('up'),
        pressDown: () => pressRole('down'),
        onProgress: (index, total) => {
          setCommand({ index, total, target });
          pressFeedback();
        },
        onCommitted: (action) => {
          const at = new Date().toISOString();
          commit((prev) => {
            if (action.kind === 'wake') {
              return appendLog(
                prev,
                'wake',
                `Wake press on the ${action.direction} bot. The setpoint stayed at ${prev.virtualSetpoint}°.`,
                at,
              );
            }
            const nextSet = action.setpointAfter ?? prev.virtualSetpoint ?? current;
            const named = action.direction === 'up' ? 'Up bot' : 'Down bot';
            return appendLog(
              { ...prev, virtualSetpoint: nextSet },
              'press',
              `${named} press. Setpoint ${nextSet}°.`,
              at,
            );
          });
        },
      });
      runningRef.current = false;
      setCommand(null);
      const at = new Date().toISOString();
      if (result.status === 'failed') {
        const reason = result.error ? ` ${result.error}` : '';
        const message = `Stopped at ${result.stoppedAt}°. Wanted ${result.wanted}°. No further presses sent.${reason}`;
        setBanner(message);
        errorFeedback();
        if (source.kind !== 'schedule') {
          commit((prev) => {
            let next = appendLog(prev, 'failure', message, at);
            if (startsHold(source)) {
              next = holdOnto(next, new Date());
            }
            return next;
          });
        }
        return { status: 'failed', stoppedAt: result.stoppedAt, wanted: result.wanted, reason: message };
      }
      if (result.status === 'cancelled') {
        const message = `Cancelled. Stopped at ${result.stoppedAt}°. Wanted ${result.wanted}°. No further presses sent.`;
        setBanner(message);
        if (source.kind !== 'schedule') {
          commit((prev) => {
            let next = appendLog(prev, 'cancel', message, at);
            if (startsHold(source)) {
              next = holdOnto(next, new Date());
            }
            return next;
          });
        }
        return { status: 'cancelled', stoppedAt: result.stoppedAt, wanted: result.wanted, reason: message };
      }
      successFeedback();
      commit((prev) => {
        let next = prev;
        if (source.kind === 'preset') {
          next = appendLog(next, 'preset', `Preset ${source.label} applied at ${target}°.`, at);
        }
        if (startsHold(source)) {
          next = holdOnto(next, new Date());
        }
        return next;
      });
      return { status: 'done', stoppedAt: result.stoppedAt, wanted: target };
    },
    [commit, pressRole],
  );

  const tick = useCallback(
    async (now: Date) => {
      if (runningRef.current || tickLock.current) {
        return;
      }
      const snapshot = stateRef.current;
      if (snapshot.virtualSetpoint === null) {
        return;
      }
      tickLock.current = true;
      const before = snapshot.virtualSetpoint;
      try {
        const outcome = await runDueSchedule({
          now,
          events: snapshot.events,
          records: snapshot.records,
          hold: snapshot.hold,
          setpoint: snapshot.virtualSetpoint,
          catchupFrom: snapshot.catchupFrom,
          retryFailed: retryArmed.current,
          execute: async (target) => {
            const result = await runTarget(target, { kind: 'schedule' });
            if (result.status === 'cancelled') {
              return { status: 'cancelled', stoppedAt: result.stoppedAt, wanted: result.wanted };
            }
            if (result.status === 'done') {
              return { status: 'done', stoppedAt: result.stoppedAt, wanted: result.wanted };
            }
            retryArmed.current = false;
            return {
              status: 'failed',
              stoppedAt: result.stoppedAt,
              wanted: result.wanted,
            };
          },
        });
        commit((prev) => {
          let next: Persisted = { ...prev, records: outcome.records, hold: outcome.hold };
          for (const line of outcome.log) {
            next = appendLog(next, line.kind, line.message, now.toISOString());
          }
          return next;
        });
        const notable = outcome.log.find((line) => line.kind === 'failure' || line.kind === 'cancel');
        if (notable) {
          setBanner(notable.message);
        }
        if (stateRef.current.virtualSetpoint !== before && outcome.log.some((line) => line.kind === 'schedule')) {
          setClock(new Date());
        }
      } finally {
        tickLock.current = false;
      }
    },
    [commit, runTarget],
  );

  tickImpl.current = tick;

  useEffect(() => {
    if (!ready || state.virtualSetpoint === null) {
      return;
    }
    void tickImpl.current(new Date());
    const timer = setInterval(() => {
      void tickImpl.current(new Date());
    }, 5000);
    const onAppState = (status: AppStateStatus) => {
      if (status === 'active') {
        retryArmed.current = true;
        void tickImpl.current(new Date());
      }
    };
    const subscription = AppState.addEventListener('change', onAppState);
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        retryArmed.current = true;
        void tickImpl.current(new Date());
      }
    };
    if (Platform.OS === 'web') {
      document.addEventListener('visibilitychange', onVisible);
    }
    return () => {
      clearInterval(timer);
      subscription.remove();
      if (Platform.OS === 'web') {
        document.removeEventListener('visibilitychange', onVisible);
      }
    };
  }, [ready, state.virtualSetpoint]);

  useEffect(() => {
    return watchNotificationOpen(() => {
      retryArmed.current = true;
      void tickImpl.current(new Date());
    });
  }, []);

  useEffect(() => {
    if (!ready || state.virtualSetpoint === null) {
      return;
    }
    void syncReminders(state.events, new Date());
  }, [ready, state.events, state.virtualSetpoint]);

  const refreshDevices = useCallback(async (): Promise<string | null> => {
    const creds = await loadCredentials();
    if (!creds) {
      setDeviceMessage('Add a token and secret before loading devices.');
      return 'Add a token and secret before loading devices.';
    }
    try {
      const list = await listDevices(creds);
      setDevices(list);
      if (list.length === 0) {
        const message =
          'No devices came back. Check the token, and that a SwitchBot Hub with cloud service enabled is near the bots and the meter.';
        setDeviceMessage(message);
        return message;
      }
      const notes = list.flatMap((device) => deviceNotes(device));
      setDeviceMessage(notes[0] ?? null);
      return null;
    } catch (error) {
      const message = explainError(error);
      setDeviceMessage(message);
      return message;
    }
  }, []);

  const value = useMemo<AppContextValue>(() => {
    return {
      ready,
      state,
      clock,
      command,
      banner,
      refreshing,
      devices,
      deviceMessage,
      hasCredentials,
      tokenMask,
      secretMask,
      clearBanner: () => setBanner(null),
      setMode: (mode) => {
        commit((prev) => ({ ...prev, mode }));
      },
      setRoomLabel: (label) => {
        commit((prev) => ({ ...prev, roomLabel: label }));
      },
      updateSettings: (patch) => {
        commit((prev) => {
          const settings = { ...prev.settings, ...patch };
          if (settings.maxF <= settings.minF) {
            settings.maxF = settings.minF + 1;
          }
          return { ...prev, settings };
        });
      },
      saveAndLoadDevices: async (token, secret) => {
        const trimmedToken = token.trim();
        const trimmedSecret = secret.trim();
        if (!trimmedToken || !trimmedSecret) {
          return 'Enter both the token and the secret.';
        }
        await saveCredentials(trimmedToken, trimmedSecret);
        setHasCredentials(true);
        setTokenMask(maskSecret(trimmedToken));
        setSecretMask(maskSecret(trimmedSecret));
        return refreshDevices();
      },
      reloadDevices: () => refreshDevices(),
      forgetCredentials: async () => {
        await clearCredentials();
        setHasCredentials(false);
        setTokenMask(null);
        setSecretMask(null);
        setDevices([]);
        setDeviceMessage(null);
      },
      mapRole: (role, device) => {
        commit((prev) => ({
          ...prev,
          deviceMap: {
            ...prev.deviceMap,
            [role]: device ? deviceFromApi(device) : null,
          },
        }));
      },
      completeCalibration: (temp) => {
        const at = new Date().toISOString();
        commit((prev) =>
          appendLog(
            { ...prev, virtualSetpoint: temp, catchupFrom: at },
            'calibration',
            `Calibrated the virtual setpoint to ${temp}°. No buttons were pressed.`,
            at,
          ),
        );
      },
      recalibrate: (temp) => {
        const at = new Date().toISOString();
        commit((prev) =>
          appendLog(
            { ...prev, virtualSetpoint: temp },
            'calibration',
            `Recalibrated the virtual setpoint to ${temp}°. No buttons were pressed.`,
            at,
          ),
        );
      },
      bump: async (direction) => {
        const current = stateRef.current.virtualSetpoint;
        if (current === null) {
          return;
        }
        await runTarget(current + direction * stateRef.current.settings.step, { kind: 'manual' });
      },
      setTo: (target) => runTarget(target, { kind: 'set-to' }),
      applyPreset: async (preset) => {
        await runTarget(preset.tempF, { kind: 'preset', label: preset.label });
      },
      cancelCommand: () => {
        cancelRef.current = true;
      },
      refreshClimate: async () => {
        if (refreshing) {
          return;
        }
        setRefreshing(true);
        try {
          const snapshot = stateRef.current;
          if (snapshot.mode === 'demo') {
            const nowIso = new Date().toISOString();
            commit((prev) => ({ ...prev, demoClimate: driftClimate(prev.demoClimate, nowIso) }));
            return;
          }
          const creds = await loadCredentials();
          if (!creds) {
            setBanner('Add a SwitchBot token and secret in Settings.');
            return;
          }
          if (!snapshot.deviceMap.meter) {
            setBanner('Map the Meter in Settings to read the room.');
            return;
          }
          const meter = await readMeter(creds, snapshot.deviceMap.meter.id);
          const batteryUp = snapshot.deviceMap.up ? await readBotBattery(creds, snapshot.deviceMap.up.id) : null;
          const batteryDown = snapshot.deviceMap.down
            ? await readBotBattery(creds, snapshot.deviceMap.down.id)
            : null;
          commit((prev) => ({
            ...prev,
            lastLive: {
              temperatureF: meter.temperatureF,
              humidity: meter.humidity,
              co2Ppm: meter.co2Ppm,
              updatedAt: new Date().toISOString(),
              batteryUp,
              batteryDown,
              batteryMeter: meter.battery,
            },
          }));
        } catch (error) {
          setBanner(explainError(error));
        } finally {
          setRefreshing(false);
        }
      },
      setCo2Band: (tone) => {
        commit((prev) => ({
          ...prev,
          demoClimate: {
            ...prev.demoClimate,
            co2Lock: tone,
            co2Ppm: co2ForBand(tone),
            updatedAt: new Date().toISOString(),
          },
        }));
      },
      setFailNext: (value) => {
        commit((prev) => ({
          ...prev,
          demoClimate: { ...prev.demoClimate, failNextPress: value },
        }));
      },
      resetDemo: () => {
        const nowIso = new Date().toISOString();
        commit((prev) =>
          appendLog(
            { ...prev, demoClimate: initialClimate(nowIso) },
            'schedule',
            'Reset the simulated room. The setpoint was left alone.',
            nowIso,
          ),
        );
      },
      updatePreset: (id, patch) => {
        commit((prev) => ({
          ...prev,
          presets: prev.presets.map((preset) => (preset.id === id ? { ...preset, ...patch } : preset)),
        }));
      },
      saveEvent: (event) => {
        const at = new Date().toISOString();
        commit((prev) => {
          const exists = prev.events.some((item) => item.id === event.id);
          const events = exists
            ? prev.events.map((item) => (item.id === event.id ? event : item))
            : [...prev.events, event];
          return appendLog(
            { ...prev, events, catchupFrom: prev.virtualSetpoint === null ? prev.catchupFrom : at },
            'schedule',
            `Updated ${event.label} · ${formatClock(event.hour, event.minute)} · ${event.targetF}°.`,
            at,
          );
        });
      },
      addEvent: () => {
        const at = new Date().toISOString();
        const setpoint = stateRef.current.virtualSetpoint ?? 68;
        const event: ScheduleEvent = {
          id: createId(),
          label: 'Custom',
          hour: 12,
          minute: 0,
          targetF: Math.min(stateRef.current.settings.maxF, Math.max(stateRef.current.settings.minF, setpoint)),
          days: [1, 2, 3, 4, 5],
          enabled: true,
        };
        commit((prev) =>
          appendLog(
            {
              ...prev,
              events: [...prev.events, event],
              catchupFrom: prev.virtualSetpoint === null ? prev.catchupFrom : at,
            },
            'schedule',
            'Added Custom.',
            at,
          ),
        );
      },
      deleteEvent: (id) => {
        const at = new Date().toISOString();
        commit((prev) => {
          const event = prev.events.find((item) => item.id === id);
          return appendLog(
            {
              ...prev,
              events: prev.events.filter((item) => item.id !== id),
              catchupFrom: prev.virtualSetpoint === null ? prev.catchupFrom : at,
            },
            'schedule',
            `Removed ${event?.label ?? 'event'}.`,
            at,
          );
        });
      },
      restoreDefaults: () => {
        const at = new Date().toISOString();
        commit((prev) =>
          appendLog(
            {
              ...prev,
              events: defaultEvents(),
              catchupFrom: prev.virtualSetpoint === null ? prev.catchupFrom : at,
            },
            'schedule',
            'Restored the default schedule.',
            at,
          ),
        );
      },
      resumeSchedule: async () => {
        const before = stateRef.current.virtualSetpoint;
        const at = new Date().toISOString();
        commit((prev) => appendLog({ ...prev, hold: null }, 'schedule', 'Following the schedule.', at));
        retryArmed.current = true;
        await tick(new Date());
        const after = stateRef.current;
        const target = currentTarget(after.events, new Date());
        if (
          target &&
          after.virtualSetpoint !== null &&
          before !== null &&
          target.targetF !== after.virtualSetpoint &&
          after.virtualSetpoint === before
        ) {
          await runTarget(target.targetF, { kind: 'resume' });
        }
      },
      applyCancelled: async (key) => {
        const record = stateRef.current.records.find((item) => item.key === key);
        if (!record) {
          return;
        }
        const result = await runTarget(record.targetF, { kind: 'apply-now' });
        if (result.status === 'done' || result.status === 'already') {
          commit((prev) => ({
            ...prev,
            records: upsertRecord(prev.records, {
              ...record,
              status: result.status === 'already' ? 'already' : 'ran',
              message: `Applied ${record.label} at ${record.targetF}°.`,
              recordedAt: new Date().toISOString(),
            }),
          }));
        }
      },
      allowReminders: async () => {
        const message = await requestReminderPermission();
        await syncReminders(stateRef.current.events, new Date());
        return message;
      },
    };
  }, [
    ready,
    state,
    clock,
    command,
    banner,
    refreshing,
    devices,
    deviceMessage,
    hasCredentials,
    tokenMask,
    secretMask,
    commit,
    refreshDevices,
    runTarget,
    tick,
  ]);

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

function holdOnto(prev: Persisted, now: Date): Persisted {
  if (prev.virtualSetpoint === null) {
    return prev;
  }
  const next = nextOccurrence(prev.events, now);
  const hold = next ? { until: next.at, label: next.label } : { until: null, label: '' };
  const message = hold.until
    ? `Holding ${prev.virtualSetpoint}° until ${hold.label} · ${formatInstant(hold.until)}.`
    : `Holding ${prev.virtualSetpoint}°. Nothing is scheduled next.`;
  return appendLog({ ...prev, hold }, 'hold', message, now.toISOString());
}

export function useApp(): AppContextValue {
  const value = useContext(AppContext);
  if (!value) {
    throw new Error('useApp must be used inside AppProvider');
  }
  return value;
}

export function suggestedTarget(state: Persisted): number {
  if (state.virtualSetpoint === null) {
    return state.settings.minF;
  }
  return nearestTarget(state.virtualSetpoint, state.settings.step, state.settings.minF, state.settings.maxF);
}
