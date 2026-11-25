import { BROWSER_BLOCKED, CHECK_THERMOSTAT } from '@/copy';
import { reduceBatteryFetch, shouldFetchBatteries, stateFromCache } from '@/domain/batteryFetch';
import { co2ForBand, type Co2Tone } from '@/domain/co2';
import {
  connectionBanner,
  CONNECTION_DOWN_AFTER_MS,
  initialConnection,
  reduceConnection,
  type Connection,
  type ConnectionEvent,
} from '@/domain/connection';
import { initialRefresh, reduceRefresh, type Refresh, type RefreshEvent, type RefreshPhase } from '@/domain/refresh';
import { chooseDevice, idleDeviceList, reduceDeviceList, type DeviceList } from '@/domain/devicePick';
import { deriveLink } from '@/domain/link';
import { lifecycleEventForAppState, reduceLifecycle, type Lifecycle } from '@/domain/lifecycle';
import { pushMessage, type AppMessage } from '@/domain/messages';
import { applyTransition, nextSkippable, occurrenceForRunNow, occurrenceOnDate } from '@/domain/occurrences';
import {
  bumpBaseForMode,
  desiredSetpoint,
  dropsDesiredOnBusy,
  idlePending,
  modeContinuation,
  reducePendingTarget,
  schedulerBlocked,
  SWITCHING_TO_OFF_REASON,
  tempContinuation,
  type CommandEndStatus,
  type PendingEvent,
  type PendingStep,
  type PendingTarget,
  type StepLimits,
} from '@/domain/pendingTarget';
import { climateOf, OFF_SETPOINT_REASON, reduceClimate, refusalFor, resolveActive, UNKNOWN_MODE_REASON } from '@/domain/modeSetpoint';
import {
  beginModeSession,
  idleModeSession,
  isModeRunning,
  modeProgress,
  runModeSession,
  type ModeSession,
} from '@/domain/modePress';
import { nearestTarget, planSetTo, type PressAction } from '@/domain/planSetTo';
import {
  beginRunningSession,
  idleSession,
  isRunning,
  PressOutcomeError,
  runPressSession,
  sessionProgress,
  shouldStartHold,
  type CommandSource,
  type PressSession,
} from '@/domain/pressSession';
import {
  chipFor,
  currentTarget,
  defaultEvents,
  holdFor,
  intendedTarget,
  planDue,
  scheduleEditResetsCursor,
  type ScheduleEvent,
} from '@/domain/schedule';
import { runDueSchedule } from '@/domain/scheduleRunner';
import { isKnownMode, modeLabel, type KnownMode, type SystemMode } from '@/domain/systemMode';
import { alreadyInMode, PICK_MODE_REASON } from '@/domain/recalibrateDraft';
import { formatClock } from '@/domain/time';
import { LOCAL_HISTORY_CAP, pageLocalChanges, seedDemoHistory, type ChangePage } from '@/domain/history';
import { localWindowData, type HistoryWindow, type HistoryWindowData } from '@/domain/historyWindow';
import { mergeMeterHistory, parseMeterCsv } from '@/domain/meterCsv';
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
import { errorFeedback, pressFeedback, successFeedback } from '@/haptics';
import { notifyCheckThermostat, requestReminderPermission, syncReminders, watchNotificationOpen } from '@/notifications/reminders';
import {
  cancelRemotePress,
  fetchChangePage,
  fetchHistoryWindow,
  importMeterCsvRemote,
  fetchRemoteDevices,
  fetchRemoteSession,
  fetchState,
  isTransientNetworkError,
  readServerConfig,
  recalibrateRemote,
  requestRemoteMeter,
  runRemoteMode,
  runRemotePress,
  saveRemoteCredentials,
  saveState,
  ServerAuthError,
  type RemoteProgress,
  type ServerConfig,
} from '@/server/appClient';
import { deleteAppKey, loadAppKey, saveAppKey } from '@/storage/appKey';
import { clearCredentials, loadCredentials, maskSecret, saveCredentials } from '@/storage/credentials';
import { loadPersisted, savePersisted } from '@/storage/persist';
import {
  appendLog,
  applyClimate,
  createDefaultState,
  createId,
  deviceFromApi,
  hasCalibration,
  idleMeterImport,
  reduceAppAccess,
  reduceMeterImport,
  type AppAccess,
  type AppAccessEvent,
  type MeterImportState,
  type Persisted,
  type Preset,
} from '@/state/model';
import { appliedWrite, recordRecalibration, type RecalibrateWrite } from '@/state/recalibrateRecord';
import {
  acceptVersion,
  applySnapshot,
  canPull,
  createSharedSync,
  MAX_PUSH_CONFLICTS,
  mergePulled,
  noteLocalChange,
  resetSync,
  settlePush,
  snapshotFrom,
  takePatch,
  type SharedSync,
} from '@/state/sharedSync';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AppState, Platform, type AppStateStatus } from 'react-native';

const FIRST_ARM_MS = 800;
const DEMO_PRESS_MS = 1200;
const FOREGROUND_REFRESH_MS = 500;

export type CommandProgress = RemoteProgress;

export type CommandResult = {
  status: 'done' | 'already' | 'cancelled' | 'failed' | 'refused' | 'busy' | 'ambiguous';
  stoppedAt: number;
  wanted: number;
  reason?: string;
};

type AppContextValue = {
  ready: boolean;
  state: Persisted;
  clock: Date;
  command: CommandProgress | null;
  desiredSetpoint: number | null;
  queuedTarget: number | null;
  queuedMode: KnownMode | null;
  banner: string | null;
  refresh: RefreshPhase;
  devices: SwitchBotDevice[];
  deviceMessage: string | null;
  hasCredentials: boolean;
  tokenMask: string | null;
  secretMask: string | null;
  serverConfigured: boolean;
  access: AppAccess;
  gateNote: string | null;
  submitAppKey: (value: string) => Promise<void>;
  clearAppKey: () => Promise<void>;
  changeAppKey: () => void;
  clearBanner: () => void;
  setMode: (mode: Persisted['mode']) => void;
  setRoomLabel: (label: string) => void;
  updateSettings: (patch: Partial<Persisted['settings']>) => void;
  saveAndLoadDevices: (token: string, secret: string) => Promise<string | null>;
  reloadDevices: () => Promise<string | null>;
  forgetCredentials: () => Promise<void>;
  mapRole: (role: 'up' | 'down' | 'mode' | 'meter', device: SwitchBotDevice | null) => void;
  completeCalibration: (temp: number) => void;
  recalibrate: (write: RecalibrateWrite) => Promise<string | null>;
  setSystemMode: (mode: KnownMode) => Promise<void>;
  bump: (direction: 1 | -1) => Promise<void>;
  setTo: (target: number) => Promise<CommandResult>;
  applyPreset: (preset: Preset) => Promise<void>;
  cancelCommand: () => void;
  refreshClimate: (source?: 'user' | 'background') => Promise<void>;
  setCo2Band: (tone: Co2Tone) => void;
  setFailNext: (value: boolean) => void;
  setLoseNext: (value: boolean) => void;
  resetDemo: () => void;
  updatePreset: (id: string, patch: Partial<Pick<Preset, 'label' | 'tempF'>>) => void;
  saveEvent: (event: ScheduleEvent) => void;
  addEvent: () => void;
  deleteEvent: (id: string) => void;
  restoreDefaults: () => void;
  resumeSchedule: () => Promise<void>;
  applyCancelled: (key: string) => Promise<void>;
  allowReminders: () => Promise<string>;
  skipNext: (eventId: string) => void;
  skipOnDate: (eventId: string, day: string) => void;
  undoOccurrence: (key: string) => Promise<void>;
  runEventNow: (eventId: string) => Promise<void>;
  retrySchedule: () => Promise<void>;
  loadHistoryWindow: (window: HistoryWindow, current: boolean) => Promise<HistoryWindowData>;
  loadChangesPage: (cursor: string | null, limit: number) => Promise<ChangePage>;
  meterImport: MeterImportState;
  openMeterImport: () => void;
  cancelMeterImport: () => void;
  dismissMeterImport: () => void;
  failMeterImport: (message: string) => void;
  submitMeterCsv: (csv: string) => Promise<void>;
};

const AppContext = createContext<AppContextValue | null>(null);

function explainError(error: unknown, secret = ''): string {
  let text = 'Something went wrong.';
  if (error instanceof ServerAuthError) {
    text = error.message;
  } else if (Platform.OS === 'web' && (error instanceof TransportError || isTransientNetworkError(error))) {
    text = BROWSER_BLOCKED;
  } else if (error instanceof Error && error.message) {
    text = error.message;
  }
  if (secret && text.includes(secret)) {
    return 'Something went wrong.';
  }
  return text;
}

function connectionFailure(error: unknown, secret: string): ConnectionEvent {
  const text = explainError(error, secret);
  if (error instanceof TransportError || isTransientNetworkError(error)) {
    return { type: 'transient-failure', error: text, at: Date.now() };
  }
  return { type: 'hard-failure', error: text };
}

function changeMark(source: CommandSource, setpoint: number): { source: string; label: string } {
  if (source.kind === 'run-now' && source.label === 'Sleep') {
    return { source: 'sleep-now', label: `Sleep now · ${setpoint}°` };
  }
  if (source.kind === 'run-now' && source.label === 'Wake') {
    return { source: 'wake-now', label: `Wake now · ${setpoint}°` };
  }
  if (source.kind === 'run-now') {
    return { source: 'run-now', label: `${source.label} now · ${setpoint}°` };
  }
  if (source.kind === 'schedule' || source.kind === 'resume' || source.kind === 'retry') {
    return { source: 'schedule', label: `Schedule · ${setpoint}°` };
  }
  if (source.kind === 'preset') {
    return { source: 'manual', label: `${source.label} · ${setpoint}°` };
  }
  return { source: 'manual', label: `Manual · ${setpoint}°` };
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<Persisted>(() => createDefaultState(new Date().toISOString()));
  const [ready, setReady] = useState(false);
  const [clock, setClock] = useState(() => new Date());
  const [command, setCommand] = useState<CommandProgress | null>(null);
  const [desired, setDesired] = useState<number | null>(null);
  const [queuedTarget, setQueuedTarget] = useState<number | null>(null);
  const [queuedMode, setQueuedMode] = useState<KnownMode | null>(null);
  const [message, setMessage] = useState<AppMessage>(null);
  const [connection, setConnection] = useState<Connection>(initialConnection);
  const [refresh, setRefresh] = useState<Refresh>(initialRefresh);
  const [devices, setDevices] = useState<SwitchBotDevice[]>([]);
  const [deviceMessage, setDeviceMessage] = useState<string | null>(null);
  const [hasCredentials, setHasCredentials] = useState(false);
  const [tokenMask, setTokenMask] = useState<string | null>(null);
  const [secretMask, setSecretMask] = useState<string | null>(null);
  const [serverConfigured] = useState(() => readServerConfig() !== null);
  const [access, setAccess] = useState<AppAccess>({ status: 'unused' });
  const [meterImport, setMeterImport] = useState<MeterImportState>(idleMeterImport);
  const [gateNote, setGateNote] = useState<string | null>(null);
  const stateRef = useRef(state);
  const appKeyRef = useRef('');
  const accessRef = useRef<AppAccess>({ status: 'unused' });
  const meterImportRef = useRef<MeterImportState>(idleMeterImport());
  const messageRef = useRef<AppMessage>(null);
  const connectionRef = useRef<Connection>(initialConnection());
  const refreshStateRef = useRef<Refresh>(initialRefresh());
  const cancelRef = useRef(false);
  const interruptRef = useRef(false);
  const sessionRef = useRef<PressSession>(idleSession());
  const modeSessionRef = useRef<ModeSession>(idleModeSession());
  const pressModeRef = useRef<(signal: AbortSignal) => Promise<void>>(async () => {
    throw new PressOutcomeError('Map the mode bot before changing the thermostat mode.', 'rejected');
  });
  const deviceListRef = useRef<DeviceList>(idleDeviceList());
  const pendingRef = useRef<PendingTarget>(idlePending());
  const queuedTargetRef = useRef<{ target: number; source: CommandSource } | null>(null);
  const queuedModeRef = useRef<KnownMode | null>(null);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushRef = useRef<() => void>(() => undefined);
  const setSystemModeRef = useRef<(mode: KnownMode) => Promise<void>>(async () => undefined);
  const runOnServerRef = useRef<
    (
      auth: { config: ServerConfig; appKey: string },
      target: number,
      source: CommandSource,
      actions: PressAction[],
    ) => Promise<CommandResult>
  >(async () => ({ status: 'failed', stoppedAt: 0, wanted: 0 }));
  const resumeAfterRef = useRef(false);
  const tickLock = useRef(false);
  const tickImpl = useRef<(now: Date) => Promise<void>>(async () => undefined);
  const lifecycleRef = useRef<Lifecycle>({ kind: 'boot' });
  const saveChain = useRef<Promise<void>>(Promise.resolve());
  const saveLatest = useRef<Persisted | null>(null);
  const pushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const syncRef = useRef<SharedSync>(createSharedSync());
  const pullSharedRef = useRef<() => Promise<void>>(async () => undefined);
  const pullFlight = useRef<Promise<void> | null>(null);
  const pushSharedRef = useRef<() => void>(() => undefined);

  const showMessage = useCallback((next: AppMessage) => {
    const merged = next === null ? null : pushMessage(messageRef.current, next);
    messageRef.current = merged;
    setMessage(merged);
  }, []);

  const applyConnection = useCallback((event: ConnectionEvent) => {
    const next = reduceConnection(connectionRef.current, event);
    if (next === connectionRef.current) {
      return;
    }
    connectionRef.current = next;
    setConnection(next);
  }, []);

  const applyRefresh = useCallback((event: RefreshEvent): Refresh => {
    const next = reduceRefresh(refreshStateRef.current, event);
    if (next === refreshStateRef.current) {
      return next;
    }
    refreshStateRef.current = next;
    setRefresh(next);
    return next;
  }, []);

  const applyAccess = useCallback((event: AppAccessEvent) => {
    const next = reduceAppAccess(accessRef.current, event);
    accessRef.current = next;
    setAccess(next);
  }, []);

  const applyMeterImport = useCallback((event: Parameters<typeof reduceMeterImport>[1]) => {
    const next = reduceMeterImport(meterImportRef.current, event);
    meterImportRef.current = next;
    setMeterImport(next);
    return next;
  }, []);

  const sessionAuth = useCallback((): { config: ServerConfig; appKey: string } | null => {
    const config = readServerConfig();
    if (!config || accessRef.current.status !== 'unlocked' || appKeyRef.current.length === 0) {
      return null;
    }
    return { config, appKey: appKeyRef.current };
  }, []);

  const noteAuth = useCallback(
    (error: unknown): boolean => {
      if (error instanceof ServerAuthError) {
        applyAccess({ type: 'rejected' });
        return true;
      }
      return false;
    },
    [applyAccess],
  );

  const noteTransportSuccess = useCallback(() => {
    applyConnection({ type: 'success' });
  }, [applyConnection]);

  const noteTransportFailure = useCallback(
    (error: unknown) => {
      if (noteAuth(error)) {
        return;
      }
      applyConnection(connectionFailure(error, appKeyRef.current));
    },
    [applyConnection, noteAuth],
  );

  const commit = useCallback((recipe: (prev: Persisted) => Persisted) => {
    const next = recipe(stateRef.current);
    stateRef.current = next;
    setState(next);
  }, []);

  const pushShared = useCallback(() => {
    const auth = sessionAuth();
    if (!auth || stateRef.current.mode !== 'live') {
      return;
    }
    if (pushTimer.current) {
      clearTimeout(pushTimer.current);
    }
    pushTimer.current = setTimeout(() => {
      pushTimer.current = null;
      const sync = syncRef.current;
      if (sync.sending.size > 0) {
        return;
      }
      const patch = takePatch(sync, stateRef.current);
      if (!patch) {
        return;
      }
      void saveState(auth.config, auth.appKey, patch)
        .then((saved) => {
          settlePush(sync, { ok: true, saved });
          noteTransportSuccess();
          commit((prev) => mergePulled(sync, prev, saved) ?? prev);
          if (sync.dirty.size > 0) {
            pushSharedRef.current();
          }
        })
        .catch((error) => {
          const conflict = error instanceof Error && error.message.includes('Pull and retry');
          settlePush(sync, { ok: false, conflict });
          if (noteAuth(error)) {
            return;
          }
          if (conflict && sync.conflicts < MAX_PUSH_CONFLICTS) {
            void pullSharedRef.current();
            return;
          }
          noteTransportFailure(error);
        });
    }, 250);
  }, [commit, noteAuth, noteTransportFailure, noteTransportSuccess, sessionAuth]);

  pushSharedRef.current = pushShared;

  const commitShared = useCallback(
    (recipe: (prev: Persisted) => Persisted) => {
      const prev = stateRef.current;
      const next = recipe(prev);
      if (next.mode === 'live' && sessionAuth()) {
        noteLocalChange(syncRef.current, prev, next);
      }
      stateRef.current = next;
      setState(next);
      pushShared();
    },
    [pushShared, sessionAuth],
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const stored = await loadPersisted(new Date().toISOString());
      const creds = await loadCredentials();
      const config = readServerConfig();
      const key = config ? await loadAppKey() : null;
      if (cancelled) {
        return;
      }
      if (stored) {
        let next = stored;
        if (hasCalibration(next) && !next.catchupFrom) {
          next = { ...next, catchupFrom: new Date().toISOString() };
        }
        stateRef.current = next;
        setState(next);
      } else if (config) {
        const next: Persisted = { ...stateRef.current, mode: 'live' };
        stateRef.current = next;
        setState(next);
      }
      if (creds) {
        setHasCredentials(true);
        setTokenMask(maskSecret(creds.token));
        setSecretMask(maskSecret(creds.secret));
      }
      if (!config) {
        applyAccess({ type: 'server-off' });
      } else if (!key) {
        applyAccess({ type: 'no-key' });
      } else {
        appKeyRef.current = key;
        applyAccess({ type: 'no-key' });
        applyAccess({ type: 'submit' });
        try {
          const snap = await fetchState(config, key);
          if (cancelled) {
            return;
          }
          acceptVersion(syncRef.current, snap.version);
          applyAccess({ type: 'accepted' });
          if (stateRef.current.mode === 'live') {
            if (serverClimateEmpty(snap) && hasCalibration(stateRef.current)) {
              const saved = await saveState(config, key, snapshotFrom(stateRef.current, syncRef.current.version));
              acceptVersion(syncRef.current, saved.version);
            } else {
              commit((prev) => applySnapshot(prev, snap));
            }
          }
        } catch (error) {
          if (cancelled) {
            return;
          }
          if (error instanceof ServerAuthError) {
            applyAccess({ type: 'rejected' });
          } else {
            applyAccess({ type: 'unreachable' });
            setGateNote("Couldn't reach the shared server. Try the key again.");
          }
        }
      }
      lifecycleRef.current = reduceLifecycle(lifecycleRef.current, 'booted');
      setReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [applyAccess, commit]);

  useEffect(() => {
    if (!ready) {
      return;
    }
    saveLatest.current = state;
    saveChain.current = saveChain.current.then(async () => {
      const snapshot = saveLatest.current;
      if (!snapshot || saveLatest.current !== snapshot) {
        return;
      }
      await savePersisted(snapshot);
    });
  }, [ready, state]);

  useEffect(() => {
    const timer = setInterval(() => {
      setClock(new Date());
    }, 20000);
    return () => {
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    return () => {
      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current);
      }
    };
  }, []);

  const pullShared = useCallback(async (options?: { allowDuringMode?: boolean }) => {
    if (pullFlight.current) {
      return pullFlight.current;
    }
    const auth = sessionAuth();
    const sync = syncRef.current;
    if (
      !auth ||
      stateRef.current.mode !== 'live' ||
      isRunning(sessionRef.current) ||
      (!options?.allowDuringMode && isModeRunning(modeSessionRef.current)) ||
      !canPull(sync)
    ) {
      return;
    }
    const flight = (async () => {
      try {
        const snap = await fetchState(auth.config, auth.appKey);
        if (!canPull(sync)) {
          noteTransportSuccess();
          return;
        }
        if (serverClimateEmpty(snap) && hasCalibration(stateRef.current)) {
          acceptVersion(sync, snap.version);
          const saved = await saveState(auth.config, auth.appKey, snapshotFrom(stateRef.current, sync.version));
          acceptVersion(sync, saved.version);
          noteTransportSuccess();
          return;
        }
        commit((prev) => mergePulled(sync, prev, snap) ?? prev);
        noteTransportSuccess();
        if (sync.dirty.size > 0 && sync.sending.size === 0 && !pushTimer.current) {
          pushSharedRef.current();
        }
      } catch (error) {
        noteTransportFailure(error);
      }
    })();
    pullFlight.current = flight;
    try {
      await flight;
    } finally {
      if (pullFlight.current === flight) {
        pullFlight.current = null;
      }
    }
  }, [commit, noteTransportFailure, noteTransportSuccess, sessionAuth]);

  pullSharedRef.current = pullShared;

  const pressRole = useCallback(
    async (direction: 'up' | 'down', signal: AbortSignal) => {
      const snapshot = stateRef.current;
      if (snapshot.mode === 'demo') {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, DEMO_PRESS_MS);
          const onAbort = () => {
            clearTimeout(timer);
            reject(new PressOutcomeError('The press was interrupted.', 'ambiguous'));
          };
          if (signal.aborted) {
            onAbort();
            return;
          }
          signal.addEventListener('abort', onAbort, { once: true });
        });
        if (snapshot.demoClimate.failNextPress) {
          commit((prev) => ({
            ...prev,
            demoClimate: { ...prev.demoClimate, failNextPress: false },
          }));
          throw new PressOutcomeError(`The ${direction} bot did not respond.`, 'rejected');
        }
        if (snapshot.demoClimate.loseNextResponse) {
          commit((prev) => ({
            ...prev,
            demoClimate: { ...prev.demoClimate, loseNextResponse: false },
          }));
          throw new PressOutcomeError('The response was lost.', 'ambiguous');
        }
        return;
      }
      const creds = await loadCredentials();
      if (!creds) {
        throw new PressOutcomeError('Add a SwitchBot token and secret in Settings.', 'rejected');
      }
      const device = direction === 'up' ? snapshot.deviceMap.up : snapshot.deviceMap.down;
      if (!device) {
        throw new PressOutcomeError(`The ${direction} bot is not mapped.`, 'rejected');
      }
      if (device.enableCloudService === false) {
        throw new PressOutcomeError(`${device.name} has cloud service turned off.`, 'rejected');
      }
      try {
        await pressBot(creds, device.id, fetch, signal);
      } catch (error) {
        if (Platform.OS === 'web') {
          throw new PressOutcomeError(BROWSER_BLOCKED, 'rejected');
        }
        if (error instanceof TransportError || error instanceof PressOutcomeError) {
          throw error;
        }
        throw new PressOutcomeError(explainError(error), 'rejected');
      }
    },
    [commit],
  );

  const finishResume = useCallback(async () => {
    const at = new Date().toISOString();
    commitShared((prev) =>
      appendLog(
        { ...prev, hold: null, schedulePhase: 'armed' },
        'schedule',
        'Following the schedule.',
        at,
      ),
    );
    await tickImpl.current(new Date());
    const after = stateRef.current;
    const target = currentTarget(after.events, new Date());
    if (target && after.virtualSetpoint !== null && target.targetF !== after.virtualSetpoint) {
      await runTargetRef.current(target.targetF, { kind: 'resume' });
    }
  }, [commitShared]);

  const runTargetRef = useRef<
    (target: number, source: CommandSource, options?: { wakeFirst?: boolean }) => Promise<CommandResult>
  >(async () => ({
    status: 'refused',
    stoppedAt: 0,
    wanted: 0,
  }));

  const clearDebounceTimer = useCallback(() => {
    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current);
      debounceTimer.current = null;
    }
  }, []);

  const clearQueuedTarget = useCallback(() => {
    queuedTargetRef.current = null;
    setQueuedTarget((current) => (current === null ? current : null));
  }, []);

  const clearQueuedMode = useCallback(() => {
    queuedModeRef.current = null;
    setQueuedMode((current) => (current === null ? current : null));
  }, []);

  const applyPending = useCallback(
    (event: PendingEvent): PendingStep => {
      const step = reducePendingTarget(pendingRef.current, event);
      pendingRef.current = step.state;
      const nextDesired = desiredSetpoint(step.state);
      setDesired((current) => (current === nextDesired ? current : nextDesired));
      if (step.effect.type === 'arm-timer') {
        clearDebounceTimer();
        debounceTimer.current = setTimeout(() => {
          debounceTimer.current = null;
          flushRef.current();
        }, step.effect.ms);
      } else if (step.effect.type !== 'none') {
        clearDebounceTimer();
      }
      return step;
    },
    [clearDebounceTimer],
  );

  const flushPending = useCallback(() => {
    if (pendingRef.current.status !== 'pending') {
      return;
    }
    if (isModeRunning(modeSessionRef.current)) {
      return;
    }
    if (isRunning(sessionRef.current)) {
      applyPending({ type: 'defer', inflight: sessionRef.current.target });
      return;
    }
    const snapshot = stateRef.current;
    const from = snapshot.virtualSetpoint;
    if (from === null) {
      applyPending({ type: 'cancel' });
      return;
    }
    const step = applyPending({
      type: 'debounce-elapsed',
      from,
      limits: {
        step: snapshot.settings.step,
        min: snapshot.settings.minF,
        max: snapshot.settings.maxF,
        pressCap: snapshot.settings.pressCap,
      },
    });
    if (step.effect.type === 'send') {
      void runTargetRef.current(step.effect.target, { kind: 'manual' }, { wakeFirst: step.effect.wake });
      return;
    }
    if (step.effect.type === 'refuse') {
      showMessage({ source: 'press', text: step.effect.reason });
      errorFeedback();
    }
  }, [applyPending, showMessage]);

  useEffect(() => {
    flushRef.current = flushPending;
  }, [flushPending]);

  const finishModeSession = useCallback(
    async (modeStatus: CommandEndStatus, landedMode: SystemMode) => {
      const hasPendingTemp = pendingRef.current.status === 'pending';
      const queued = queuedTargetRef.current;
      const resumeQueued = resumeAfterRef.current;
      const decision = modeContinuation({
        modeStatus,
        landedMode,
        hasPendingTemp,
        hasQueuedTarget: queued !== null,
        resumeQueued,
      });
      if (decision === 'drop-queued') {
        resumeAfterRef.current = false;
        clearQueuedTarget();
        applyPending({ type: 'cancel' });
        if ((hasPendingTemp || queued !== null || resumeQueued) && landedMode === 'off') {
          showMessage({ source: 'press', text: OFF_SETPOINT_REASON });
          errorFeedback();
        }
        setCommand(null);
        return;
      }
      if (decision === 'resume') {
        resumeAfterRef.current = false;
        clearQueuedTarget();
        applyPending({ type: 'cancel' });
        setCommand(null);
        await finishResume();
        return;
      }
      if (decision === 'run-queued-target' && queued) {
        clearQueuedTarget();
        applyPending({ type: 'cancel' });
        await runTargetRef.current(queued.target, queued.source);
        return;
      }
      if (decision === 'flush-pending') {
        if (debounceTimer.current === null) {
          flushRef.current();
          if (!isRunning(sessionRef.current)) {
            setCommand(null);
          }
        } else {
          setCommand(null);
        }
        return;
      }
      setCommand(null);
    },
    [applyPending, clearQueuedTarget, finishResume, showMessage],
  );

  const finishCommand = useCallback(async (result: CommandResult, resume: boolean): Promise<CommandResult> => {
    if (result.status === 'busy') {
      if (dropsDesiredOnBusy('foreign')) {
        applyPending({ type: 'foreign-busy' });
      }
      clearQueuedMode();
      setCommand(null);
      return result;
    }
    const settings = stateRef.current.settings;
    const step = resume
      ? null
      : applyPending({
          type: 'settled',
          stoppedAt: result.stoppedAt,
          status: result.status,
          limits: {
            step: settings.step,
            min: settings.minF,
            max: settings.maxF,
            pressCap: settings.pressCap,
          },
        });
    const nextMode = queuedModeRef.current;
    const continuation = tempContinuation({
      tempStatus: result.status,
      resumeQueued: resume,
      follow: step?.effect.type === 'send',
      hasQueuedMode: nextMode !== null,
    });
    if (continuation === 'resume') {
      applyPending({ type: 'cancel' });
      clearQueuedMode();
      resumeAfterRef.current = false;
      setCommand(null);
      await finishResume();
      return result;
    }
    if (continuation === 'follow' && step?.effect.type === 'send') {
      void runTargetRef.current(step.effect.target, { kind: 'manual' }, { wakeFirst: step.effect.wake }).catch(
        () => undefined,
      );
      return result;
    }
    if (continuation === 'run-queued-mode' && nextMode) {
      clearQueuedMode();
      await setSystemModeRef.current(nextMode);
      return result;
    }
    if (continuation === 'drop-queued-mode') {
      clearQueuedMode();
    }
    if (step?.effect.type === 'refuse') {
      showMessage({ source: 'press', text: step.effect.reason });
      errorFeedback();
    }
    setCommand(null);
    return result;
  }, [applyPending, clearQueuedMode, finishResume, showMessage]);

  const runTarget = useCallback(
    async (target: number, source: CommandSource, options?: { wakeFirst?: boolean }): Promise<CommandResult> => {
      if (isModeRunning(modeSessionRef.current)) {
        if (source.kind === 'schedule' || source.kind === 'resume') {
          const stoppedAt = stateRef.current.virtualSetpoint ?? target;
          return { status: 'busy', stoppedAt, wanted: target, reason: 'A mode change is already running.' };
        }
        if (modeSessionRef.current.target === 'off') {
          showMessage({ source: 'press', text: SWITCHING_TO_OFF_REASON });
          errorFeedback();
          return { status: 'refused', stoppedAt: target, wanted: target, reason: SWITCHING_TO_OFF_REASON };
        }
        applyPending({ type: 'cancel' });
        queuedTargetRef.current = { target, source };
        setQueuedTarget(target);
        return { status: 'done', stoppedAt: target, wanted: target };
      }
      if (isRunning(sessionRef.current)) {
        const stoppedAt = stateRef.current.virtualSetpoint ?? target;
        const reason = 'A command is already running.';
        showMessage({ source: 'press', text: reason });
        if (dropsDesiredOnBusy('self')) {
          applyPending({ type: 'foreign-busy' });
        }
        return { status: 'busy', stoppedAt, wanted: target, reason };
      }
      const snapshot = stateRef.current;
      const active = resolveActive(snapshot.systemMode, { heat: snapshot.heatSetpoint, cool: snapshot.coolSetpoint });
      if (active.status !== 'active') {
        const reason = refusalFor(active) ?? 'Set the virtual setpoint first.';
        if (source.kind !== 'schedule') {
          showMessage({ source: 'press', text: reason });
        }
        return { status: 'refused', stoppedAt: target, wanted: target, reason };
      }
      const machine = pendingRef.current;
      const alreadyArmed =
        (machine.status === 'running' || machine.status === 'running-with-newer') && machine.inflight === target;
      if (!alreadyArmed) {
        applyPending({ type: 'arm-external', target });
      }
      const current = active.degrees;
      const wakeFirst = options?.wakeFirst ?? snapshot.settings.wakeFirst;
      const plan = planSetTo({
        current,
        target,
        step: snapshot.settings.step,
        minF: snapshot.settings.minF,
        maxF: snapshot.settings.maxF,
        pressCap: snapshot.settings.pressCap,
        wakeFirst,
      });
      const finish = (result: CommandResult) => finishCommand(result, false);
      if (!plan.ok) {
        if (source.kind !== 'schedule') {
          showMessage({ source: 'press', text: plan.reason });
          errorFeedback();
        }
        return finish({ status: 'refused', stoppedAt: current, wanted: target, reason: plan.reason });
      }
      const link = deriveLink({
        mode: snapshot.mode,
        hasCredentials,
        serverConfigured,
        up: snapshot.deviceMap.up,
        down: snapshot.deviceMap.down,
        meter: snapshot.deviceMap.meter,
      });
      if (link.kind === 'live' && link.phase === 'needs-credentials') {
        const reason = 'Add a SwitchBot token and secret in Settings.';
        if (source.kind !== 'schedule') {
          showMessage({ source: 'press', text: reason });
        }
        return finish({ status: 'refused', stoppedAt: current, wanted: target, reason });
      }
      if (link.kind === 'live' && link.phase === 'needs-bots') {
        const reason = 'Map the up bot and the down bot in Settings before sending presses.';
        if (source.kind !== 'schedule') {
          showMessage({ source: 'press', text: reason });
        }
        return finish({ status: 'refused', stoppedAt: current, wanted: target, reason });
      }
      if (link.kind === 'live' && link.phase === 'ready' && link.cloud === 'off') {
        const reason = 'Cloud service is off. Turn it on in the SwitchBot app. Setpoint does not fall back to Bluetooth.';
        if (source.kind !== 'schedule') {
          showMessage({ source: 'press', text: reason });
        }
        return finish({ status: 'refused', stoppedAt: current, wanted: target, reason });
      }
      if (plan.actions.length === 0) {
        if (source.kind !== 'schedule') {
          const at = new Date().toISOString();
          commit((prev) => appendLog(prev, 'schedule', `Already at ${target}°. No presses sent.`, at));
        }
        return finish({ status: 'already', stoppedAt: current, wanted: target });
      }
      const auth = sessionAuth();
      if (snapshot.mode === 'live' && readServerConfig()) {
        if (!auth) {
          const reason = 'Enter the app key before sending a press.';
          if (source.kind !== 'schedule') {
            showMessage({ source: 'press', text: reason });
          }
          return finish({ status: 'refused', stoppedAt: current, wanted: target, reason });
        }
        return finish(await runOnServerRef.current(auth, target, source, plan.actions));
      }
      cancelRef.current = false;
      interruptRef.current = false;
      if (source.kind !== 'schedule') {
        showMessage(null);
      }
      let settled: Awaited<ReturnType<typeof runPressSession>>;
      try {
        settled = await runPressSession({
          current,
          target,
          source,
          mode: snapshot.mode,
          plan,
          delayMs: snapshot.settings.delayMs,
          press: (direction, signal) => pressRole(direction, signal),
          sleep: (ms, isCancelled) => sleepUnless(ms, isCancelled),
          beforeSend: async (index, isCancelled) => {
            if (index === 0) {
              return sleepUnless(FIRST_ARM_MS, isCancelled);
            }
            return isCancelled();
          },
          isCancelled: () => cancelRef.current,
          isInterrupted: () => interruptRef.current,
          onSession: (session) => {
            sessionRef.current = session;
            const progress = sessionProgress(session);
            if (progress) {
              setCommand(progress);
            }
          },
          onCommitted: (action, setpoint) => {
            const at = new Date().toISOString();
            if (action.kind === 'wake') {
              commit((prev) =>
                appendLog(
                  prev,
                  'wake',
                  `Wake press on the ${action.direction} bot. The setpoint stayed at ${prev.virtualSetpoint}°.`,
                  at,
                ),
              );
              return;
            }
            const mark = changeMark(source, setpoint);
            commit((prev) => {
              const climate = reduceClimate(climateOf(prev), { type: 'set-active', kind: 'adjust', degrees: setpoint });
              const next = climate.reason ? prev : applyClimate(prev, climate.state);
              return appendLog(
                {
                  ...next,
                  changes: [...next.changes, { at, setpoint, source: mark.source, label: mark.label }].slice(-400),
                },
                'press',
                `${action.direction === 'up' ? 'Up bot' : 'Down bot'} press. Setpoint ${setpoint}°.`,
                at,
              );
            });
            pressFeedback();
          },
        });
      } catch (error) {
        sessionRef.current = idleSession();
        const reason = explainError(error);
        showMessage({ source: 'press', text: reason });
        errorFeedback();
        return finishCommand(
          {
            status: 'failed',
            stoppedAt: stateRef.current.virtualSetpoint ?? target,
            wanted: target,
            reason,
          },
          false,
        );
      }
      sessionRef.current = idleSession();
      const at = new Date().toISOString();
      if (settled.status === 'ambiguous') {
        showMessage({ source: 'press', text: CHECK_THERMOSTAT });
        errorFeedback();
        commit((prev) => appendLog(prev, 'failure', CHECK_THERMOSTAT, at));
        void notifyCheckThermostat(CHECK_THERMOSTAT);
      } else if (settled.status === 'failed' || settled.status === 'refused') {
        const text = settled.reason
          ? `Stopped at ${settled.stoppedAt}°. Wanted ${settled.wanted}°. ${settled.reason}`
          : `Stopped at ${settled.stoppedAt}°. Wanted ${settled.wanted}°. No further presses sent.`;
        showMessage({ source: 'press', text });
        errorFeedback();
        if (source.kind !== 'schedule') {
          commit((prev) => appendLog(prev, 'failure', text, at));
        }
      } else if (settled.status === 'cancelled') {
        const text =
          settled.committedAdjusts > 0
            ? `Finishing the current press. Stopped at ${settled.stoppedAt}°. Wanted ${settled.wanted}°.`
            : `Cancelled before the press was sent. Stopped at ${settled.stoppedAt}°. Wanted ${settled.wanted}°.`;
        showMessage({ source: 'press', text });
        if (source.kind !== 'schedule') {
          commit((prev) => appendLog(prev, 'cancel', text, at));
        }
      } else if (settled.status === 'done') {
        successFeedback();
        if (source.kind === 'preset') {
          commit((prev) => appendLog(prev, 'preset', `Preset ${source.label} applied at ${target}°.`, at));
        }
      }
      if (shouldStartHold(source, settled) && !resumeAfterRef.current) {
        commitShared((prev) => {
          const hold = holdFor(prev.events, new Date());
          const text =
            hold?.kind === 'until-event'
              ? `Holding ${prev.virtualSetpoint}° until ${hold.label}. Only the latest due change runs after that.`
              : `Holding ${prev.virtualSetpoint}°. Nothing is scheduled next.`;
          return appendLog({ ...prev, hold }, 'hold', text, at);
        });
      }
      return finishCommand(
        {
          status: settled.status === 'busy' ? 'busy' : settled.status,
          stoppedAt: settled.stoppedAt,
          wanted: settled.wanted,
          reason: settled.reason,
        },
        resumeAfterRef.current,
      );
    },
    [applyPending, commit, commitShared, finishCommand, hasCredentials, pressRole, serverConfigured, sessionAuth, showMessage],
  );

  const runOnServer = useCallback(async function runOnServer(
    auth: { config: ServerConfig; appKey: string },
    target: number,
    source: CommandSource,
    actions: PressAction[],
  ): Promise<CommandResult> {
    let closed = false;
    const opened = beginRunningSession({
      target,
      startedFrom: stateRef.current.virtualSetpoint ?? target,
      actions,
      source,
      mode: 'live',
    });
    if (opened) {
      sessionRef.current = opened.session;
      setCommand(opened.progress);
    }
    const poll = setInterval(() => {
      void fetchRemoteSession(auth.config, auth.appKey)
        .then((remote) => {
          if (!closed && remote.progress) {
            setCommand(remote.progress);
          }
        })
        .catch(() => undefined);
    }, 400);
    try {
      const result = await runRemotePress(auth.config, auth.appKey, { target, source });
      if (result.notifyCheck || result.status === 'ambiguous') {
        showMessage({ source: 'press', text: CHECK_THERMOSTAT });
        void notifyCheckThermostat(CHECK_THERMOSTAT);
      } else if (result.reason && result.status !== 'done' && result.status !== 'already') {
        showMessage({ source: 'press', text: result.reason });
      }
      sessionRef.current = idleSession();
      await pullShared();
      return {
        status: result.status,
        stoppedAt: result.stoppedAt,
        wanted: result.wanted,
        reason: result.reason,
      };
    } catch (error) {
      noteAuth(error);
      const reason = explainError(error, appKeyRef.current);
      showMessage({ source: 'press', text: reason });
      return {
        status: 'failed',
        stoppedAt: stateRef.current.virtualSetpoint ?? target,
        wanted: target,
        reason,
      };
    } finally {
      closed = true;
      clearInterval(poll);
      sessionRef.current = idleSession();
    }
  }, [noteAuth, pullShared, showMessage]);

  useEffect(() => {
    runOnServerRef.current = runOnServer;
  }, [runOnServer]);

  runTargetRef.current = runTarget;

  const tick = useCallback(
    async (now: Date) => {
      if (
        schedulerBlocked(pendingRef.current) ||
        isRunning(sessionRef.current) ||
        isModeRunning(modeSessionRef.current) ||
        queuedTargetRef.current !== null ||
        queuedModeRef.current !== null ||
        tickLock.current
      ) {
        return;
      }
      const snapshot = stateRef.current;
      if (snapshot.mode === 'live' && readServerConfig()) {
        // Live mode always pulls, including while the thermostat is Off or the
        // mode is unknown (both have no active setpoint).
        await pullShared();
        return;
      }
      if (snapshot.virtualSetpoint === null) {
        const preview = planDue({
          events: snapshot.events,
          records: snapshot.records,
          now,
          hold: snapshot.hold,
          catchupFrom: snapshot.catchupFrom,
          retryFailed: snapshot.schedulePhase === 'armed',
          step: snapshot.settings.step,
        });
        if (!preview.apply?.mode) {
          return;
        }
      }
      tickLock.current = true;
      try {
        const outcome = await runDueSchedule({
          now,
          events: snapshot.events,
          records: snapshot.records,
          hold: snapshot.hold,
          climate: {
            systemMode: snapshot.systemMode,
            heatSetpoint: snapshot.heatSetpoint,
            coolSetpoint: snapshot.coolSetpoint,
          },
          catchupFrom: snapshot.catchupFrom,
          retryFailed: snapshot.schedulePhase === 'armed',
          step: snapshot.settings.step,
          schedulePhase: snapshot.schedulePhase,
          pressMode: async (target) => {
            const from = stateRef.current.systemMode;
            if (from === 'unknown') {
              return { status: 'refused', reason: UNKNOWN_MODE_REASON, reached: 'unknown' };
            }
            cancelRef.current = false;
            interruptRef.current = false;
            const settled = await runModeSession({
              from,
              target,
              step: stateRef.current.settings.modeStep,
              source: { kind: 'set-mode' },
              delayMs: stateRef.current.settings.delayMs,
              press: (signal) => pressModeRef.current(signal),
              sleep: (ms, isCancelled) => sleepUnless(ms, isCancelled),
              beforeSend: async (index, isCancelled) => {
                if (index === 0) {
                  return sleepUnless(FIRST_ARM_MS, isCancelled);
                }
                return isCancelled();
              },
              isCancelled: () => cancelRef.current,
              isInterrupted: () => interruptRef.current,
              onSession: (session) => {
                modeSessionRef.current = session;
                const progress = modeProgress(session);
                if (progress) {
                  setCommand(modeCommandProgress(progress));
                }
              },
              onCommitted: (mode) => {
                const at = new Date().toISOString();
                commit((prev) => {
                  const climate = reduceClimate(climateOf(prev), { type: 'recalibrate-mode', mode });
                  return appendLog(
                    applyClimate(prev, climate.state),
                    'press',
                    `Mode bot press. The thermostat is ${modeLabel(mode)}.`,
                    at,
                  );
                });
                pressFeedback();
              },
            });
            modeSessionRef.current = idleModeSession();
            if (settled.status === 'ambiguous') {
              showMessage({ source: 'press', text: CHECK_THERMOSTAT });
              errorFeedback();
              void notifyCheckThermostat(CHECK_THERMOSTAT);
            }
            return { status: settled.status, reason: settled.reason, reached: settled.tracked };
          },
          execute: async (nextTarget) => {
            const result = await runTarget(nextTarget, { kind: 'schedule' });
            if (result.status === 'done' || result.status === 'already' || result.status === 'cancelled' || result.status === 'busy') {
              return { status: result.status, stoppedAt: result.stoppedAt, wanted: result.wanted, reason: result.reason };
            }
            if (result.status === 'refused' || result.status === 'ambiguous') {
              return { status: result.status, stoppedAt: result.stoppedAt, wanted: result.wanted, reason: result.reason };
            }
            return { status: 'failed', stoppedAt: result.stoppedAt, wanted: result.wanted, reason: result.reason };
          },
        });
        commitShared((prev) => {
          let next: Persisted = {
            ...prev,
            records: outcome.records,
            hold: outcome.hold,
            schedulePhase: outcome.schedulePhase,
            catchupNote: outcome.catchupNote ?? prev.catchupNote,
          };
          for (const line of outcome.log) {
            next = appendLog(next, line.kind, line.message, now.toISOString());
          }
          return next;
        });
        const notable = outcome.log.find((line) => line.kind === 'failure' || line.kind === 'cancel');
        if (notable) {
          showMessage({ source: 'schedule', text: notable.message });
        }
      } finally {
        tickLock.current = false;
      }
    },
    [commit, commitShared, pullShared, runTarget, showMessage],
  );

  tickImpl.current = tick;

  useEffect(() => {
    if (connection.status !== 'flaky') {
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      const current = connectionRef.current;
      if (current.status !== 'flaky') {
        return;
      }
      const wait = current.since + CONNECTION_DOWN_AFTER_MS - Date.now();
      timer = setTimeout(() => {
        const latest = connectionRef.current;
        if (latest.status !== 'flaky') {
          return;
        }
        const now = Date.now();
        if (now - latest.since >= CONNECTION_DOWN_AFTER_MS) {
          applyConnection({ type: 'foreground', at: now });
          return;
        }
        arm();
      }, Math.max(0, wait));
    };
    arm();
    return () => {
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, [applyConnection, connection]);

  useEffect(() => {
    if (!ready) {
      return;
    }
    void tickImpl.current(new Date());
    void refreshRef.current();
    const timer = setInterval(() => {
      void tickImpl.current(new Date());
    }, 5000);
    let resumeTimer: ReturnType<typeof setTimeout> | null = null;
    const pause = () => {
      if (resumeTimer) {
        clearTimeout(resumeTimer);
        resumeTimer = null;
      }
      const event = lifecycleEventForAppState(lifecycleRef.current, 'background');
      if (!event) {
        return;
      }
      lifecycleRef.current = reduceLifecycle(lifecycleRef.current, event);
      if (isRunning(sessionRef.current) || isModeRunning(modeSessionRef.current) || queuedTargetRef.current !== null || queuedModeRef.current !== null) {
        interruptRef.current = true;
        lifecycleRef.current = reduceLifecycle(lifecycleRef.current, 'press-interrupted');
      }
    };
    const resume = () => {
      if (lifecycleEventForAppState(lifecycleRef.current, 'active') !== 'foreground') {
        return;
      }
      lifecycleRef.current = reduceLifecycle(lifecycleRef.current, 'foreground');
      commit((prev) => (prev.schedulePhase === 'armed' ? prev : { ...prev, schedulePhase: 'armed' }));
      if (resumeTimer) {
        clearTimeout(resumeTimer);
      }
      resumeTimer = setTimeout(() => {
        resumeTimer = null;
        void (async () => {
          await tickImpl.current(new Date());
          await refreshRef.current();
          applyConnection({ type: 'foreground', at: Date.now() });
        })();
      }, FOREGROUND_REFRESH_MS);
    };
    const onAppState = (status: AppStateStatus) => {
      const event = lifecycleEventForAppState(lifecycleRef.current, status);
      if (event === 'foreground') {
        resume();
        return;
      }
      if (event === 'background') {
        pause();
      }
    };
    const subscription = AppState.addEventListener('change', onAppState);
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        resume();
        return;
      }
      if (document.visibilityState === 'hidden') {
        pause();
      }
    };
    if (Platform.OS === 'web') {
      document.addEventListener('visibilitychange', onVisible);
    }
    return () => {
      clearInterval(timer);
      if (resumeTimer) {
        clearTimeout(resumeTimer);
      }
      subscription.remove();
      if (Platform.OS === 'web') {
        document.removeEventListener('visibilitychange', onVisible);
      }
    };
  }, [applyConnection, commit, ready]);

  useEffect(() => {
    return watchNotificationOpen(() => {
      commit((prev) => ({ ...prev, schedulePhase: 'armed' }));
      void tickImpl.current(new Date());
    });
  }, [commit]);

  useEffect(() => {
    if (!ready || state.virtualSetpoint === null) {
      return;
    }
    void syncReminders(state.events, new Date());
  }, [ready, state.events, state.virtualSetpoint === null]);

  const refreshDevices = useCallback(async (): Promise<string | null> => {
    const auth = sessionAuth();
    const beginList = () => {
      deviceListRef.current = reduceDeviceList(deviceListRef.current, { type: 'start' });
    };
    const finishList = (devices: SwitchBotDevice[]) => {
      deviceListRef.current = reduceDeviceList(deviceListRef.current, {
        type: 'loaded',
        devices: devices.map((device) => ({
          deviceId: device.deviceId,
          deviceName: device.deviceName,
          deviceType: device.deviceType,
          enableCloudService: device.enableCloudService,
          hubDeviceId: device.hubDeviceId,
        })),
      });
    };
    const failList = (message: string) => {
      deviceListRef.current = reduceDeviceList(deviceListRef.current, { type: 'fail', message });
    };
    if (readServerConfig()) {
      if (!auth) {
        const note = 'Enter the app key before loading devices.';
        setDeviceMessage(note);
        return note;
      }
      beginList();
      try {
        const listed = await fetchRemoteDevices(auth.config, auth.appKey);
        finishList(listed.devices);
        setDevices(listed.devices);
        if (listed.devices.length === 0) {
          const note =
            'No devices came back. Check the SwitchBot secret on the server, and that a hub with cloud service is near the bots and the meter.';
          setDeviceMessage(note);
          return note;
        }
        const notes = listed.devices.flatMap((device) => deviceNotes(device));
        setDeviceMessage(notes[0] ?? null);
        return null;
      } catch (error) {
        noteAuth(error);
        const note = explainError(error, appKeyRef.current);
        failList(note);
        setDeviceMessage(note);
        return note;
      }
    }
    const creds = await loadCredentials();
    if (!creds) {
      setDeviceMessage('Add a token and secret before loading devices.');
      return 'Add a token and secret before loading devices.';
    }
    beginList();
    try {
      const list = await listDevices(creds);
      finishList(list);
      setDevices(list);
      if (list.length === 0) {
        const note =
          'No devices came back. Check the token, and that a SwitchBot Hub with cloud service enabled is near the bots and the meter.';
        setDeviceMessage(note);
        return note;
      }
      const notes = list.flatMap((device) => deviceNotes(device));
      setDeviceMessage(notes[0] ?? null);
      return null;
    } catch (error) {
      const note = explainError(error, appKeyRef.current);
      failList(note);
      setDeviceMessage(note);
      return note;
    }
  }, [noteAuth, sessionAuth]);

  const refreshClimate = useCallback(async (source: 'user' | 'background' = 'background') => {
    const current = refreshStateRef.current;
    if (current.phase !== 'idle') {
      applyRefresh({ type: 'start', source });
      return;
    }
    const started = applyRefresh({ type: 'start', source });
    const epoch = started.epoch;
    try {
      const snapshot = stateRef.current;
      const nowIso = new Date().toISOString();
      if (snapshot.mode === 'demo') {
        commit((prev) => {
          const climate = driftClimate(prev.demoClimate, nowIso);
          return {
            ...prev,
            demoClimate: climate,
            history: [
              ...prev.history,
              { at: nowIso, temperatureF: climate.temperatureF, humidity: climate.humidity, co2Ppm: climate.co2Ppm },
            ].slice(-LOCAL_HISTORY_CAP),
          };
        });
        return;
      }
      const auth = sessionAuth();
      if (readServerConfig()) {
        if (!auth) {
          return;
        }
        const meter = await requestRemoteMeter(auth.config, auth.appKey);
        noteTransportSuccess();
        if (meter.sample || meter.batteries) {
          commit((prev) => ({
            ...prev,
            batteryCache: meter.batteries ?? prev.batteryCache,
            lastLive: {
              temperatureF: meter.sample?.temperatureF ?? prev.lastLive?.temperatureF ?? 0,
              humidity: meter.sample?.humidity ?? prev.lastLive?.humidity ?? 0,
              co2Ppm: meter.sample?.co2Ppm ?? prev.lastLive?.co2Ppm ?? 0,
              updatedAt: meter.sample?.at ?? nowIso,
              batteryUp: meter.batteries?.up ?? prev.lastLive?.batteryUp ?? null,
              batteryDown: meter.batteries?.down ?? prev.lastLive?.batteryDown ?? null,
              batteryMode: meter.batteries?.mode ?? prev.lastLive?.batteryMode ?? null,
              batteryMeter: prev.lastLive?.batteryMeter ?? null,
            },
            history: meter.sample ? [...prev.history, meter.sample].slice(-LOCAL_HISTORY_CAP) : prev.history,
          }));
        }
        return;
      }
      const creds = await loadCredentials();
      if (!creds) {
        applyConnection({ type: 'hard-failure', error: 'Add a SwitchBot token and secret in Settings.' });
        return;
      }
      if (!snapshot.deviceMap.meter) {
        applyConnection({ type: 'hard-failure', error: 'Map the Meter in Settings to read the room.' });
        return;
      }
      const meter = await readMeter(creds, snapshot.deviceMap.meter.id);
      const nowMs = Date.now();
      const cached = stateFromCache(snapshot.batteryCache, nowMs);
      let batteryUp = snapshot.batteryCache?.up ?? snapshot.lastLive?.batteryUp ?? null;
      let batteryDown = snapshot.batteryCache?.down ?? snapshot.lastLive?.batteryDown ?? null;
      let batteryMode = snapshot.batteryCache?.mode ?? snapshot.lastLive?.batteryMode ?? null;
      let batteryCache = snapshot.batteryCache;
      if (shouldFetchBatteries(cached, nowMs)) {
        const loading = reduceBatteryFetch(cached, { type: 'start' });
        try {
          batteryUp = snapshot.deviceMap.up ? await readBotBattery(creds, snapshot.deviceMap.up.id) : null;
          batteryDown = snapshot.deviceMap.down ? await readBotBattery(creds, snapshot.deviceMap.down.id) : null;
          batteryMode = snapshot.deviceMap.mode ? await readBotBattery(creds, snapshot.deviceMap.mode.id) : null;
          const reading = { up: batteryUp, down: batteryDown, mode: batteryMode, fetchedAt: nowIso };
          reduceBatteryFetch(loading, { type: 'succeed', reading });
          batteryCache = reading;
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Battery read failed.';
          reduceBatteryFetch(loading, { type: 'fail', error: message, at: nowIso });
          batteryCache = snapshot.batteryCache
            ? { ...snapshot.batteryCache, failedAt: nowIso }
            : { up: batteryUp, down: batteryDown, mode: batteryMode, fetchedAt: nowIso, failedAt: nowIso };
        }
      }
      commit((prev) => ({
        ...prev,
        batteryCache,
        lastLive: {
          temperatureF: meter.temperatureF,
          humidity: meter.humidity,
          co2Ppm: meter.co2Ppm,
          updatedAt: nowIso,
          batteryUp,
          batteryDown,
          batteryMode,
          batteryMeter: meter.battery,
        },
        history: [
          ...prev.history,
          { at: nowIso, temperatureF: meter.temperatureF, humidity: meter.humidity, co2Ppm: meter.co2Ppm },
        ].slice(-LOCAL_HISTORY_CAP),
      }));
      noteTransportSuccess();
    } catch (error) {
      noteTransportFailure(error);
    } finally {
      applyRefresh({ type: 'settle', epoch });
    }
  }, [applyConnection, applyRefresh, commit, noteTransportFailure, noteTransportSuccess, sessionAuth]);

  const refreshRef = useRef(refreshClimate);
  refreshRef.current = refreshClimate;

  const pressMode = useCallback(async (signal: AbortSignal) => {
    const snapshot = stateRef.current;
    if (snapshot.mode === 'demo') {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, DEMO_PRESS_MS);
        const onAbort = () => {
          clearTimeout(timer);
          reject(new PressOutcomeError('The press was interrupted.', 'ambiguous'));
        };
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      });
      return;
    }
    const creds = await loadCredentials();
    if (!creds) {
      throw new PressOutcomeError('Add a SwitchBot token and secret in Settings.', 'rejected');
    }
    const device = snapshot.deviceMap.mode;
    if (!device) {
      throw new PressOutcomeError('Map the mode bot before changing the thermostat mode.', 'rejected');
    }
    if (device.enableCloudService === false) {
      throw new PressOutcomeError(`${device.name} has cloud service turned off.`, 'rejected');
    }
    try {
      await pressBot(creds, device.id, fetch, signal);
    } catch (error) {
      if (Platform.OS === 'web') {
        throw new PressOutcomeError(BROWSER_BLOCKED, 'rejected');
      }
      if (error instanceof TransportError || error instanceof PressOutcomeError) {
        throw error;
      }
      throw new PressOutcomeError(explainError(error), 'rejected');
    }
  }, []);

  useEffect(() => {
    pressModeRef.current = pressMode;
  }, [pressMode]);

  const showModeProgress = useCallback((progress: { index: number; total: number; target: KnownMode; label: 'press' | 'finishing' }) => {
    setCommand(modeCommandProgress(progress));
  }, []);

  const setSystemMode = useCallback(
    async (target: KnownMode) => {
      if (pendingRef.current.status === 'pending' && !isModeRunning(modeSessionRef.current)) {
        clearDebounceTimer();
        flushRef.current();
      }
      if (isRunning(sessionRef.current) || pendingRef.current.status === 'pending') {
        if (isModeRunning(modeSessionRef.current)) {
          showMessage({ source: 'press', text: 'A mode change is already running.' });
          return;
        }
        const currentMode = stateRef.current.systemMode;
        if (currentMode === target) {
          showMessage({ source: 'press', text: alreadyInMode(target) });
          return;
        }
        if (currentMode === 'unknown') {
          showMessage({ source: 'press', text: UNKNOWN_MODE_REASON });
          return;
        }
        queuedModeRef.current = target;
        setQueuedMode(target);
        return;
      }
      if (isModeRunning(modeSessionRef.current)) {
        showMessage({ source: 'press', text: 'A mode change is already running.' });
        return;
      }
      const snapshot = stateRef.current;
      if (snapshot.systemMode === target) {
        showMessage({ source: 'press', text: alreadyInMode(target) });
        return;
      }
      if (snapshot.systemMode === 'unknown') {
        showMessage({ source: 'press', text: UNKNOWN_MODE_REASON });
        return;
      }
      const auth = sessionAuth();
      if (auth && snapshot.mode === 'live') {
        const opened = beginModeSession({
          from: snapshot.systemMode,
          target,
          step: snapshot.settings.modeStep,
          source: { kind: 'set-mode' },
        });
        if (opened) {
          modeSessionRef.current = opened.session;
          showModeProgress(opened.progress);
        }
        let closed = false;
        let modeStatus: CommandEndStatus = 'failed';
        const poll = setInterval(() => {
          void fetchRemoteSession(auth.config, auth.appKey)
            .then((remote) => {
              if (!closed && remote.progress?.kind === 'mode') {
                setCommand(remote.progress);
              }
            })
            .catch(() => undefined);
        }, 400);
        try {
          const result = await runRemoteMode(auth.config, auth.appKey, target);
          closed = true;
          clearInterval(poll);
          modeStatus =
            result.status === 'done' ||
            result.status === 'already' ||
            result.status === 'cancelled' ||
            result.status === 'failed' ||
            result.status === 'refused' ||
            result.status === 'busy' ||
            result.status === 'ambiguous'
              ? result.status
              : 'failed';
          if (isKnownMode(result.systemMode) && result.systemMode !== stateRef.current.systemMode) {
            const reached = result.systemMode;
            const at = new Date().toISOString();
            commit((prev) => {
              const climate = reduceClimate(climateOf(prev), { type: 'recalibrate-mode', mode: reached });
              return appendLog(applyClimate(prev, climate.state), 'press', `Mode bot press. The thermostat is ${modeLabel(reached)}.`, at);
            });
          }
          if (result.status === 'done') {
            successFeedback();
          } else if (result.status === 'failed' || result.status === 'refused' || result.status === 'ambiguous') {
            errorFeedback();
          }
          if (result.notifyCheck || result.status === 'ambiguous') {
            showMessage({ source: 'press', text: CHECK_THERMOSTAT });
            void notifyCheckThermostat(CHECK_THERMOSTAT);
          } else if (result.reason && result.status !== 'done' && result.status !== 'already') {
            showMessage({ source: 'press', text: result.reason });
          }
          await pullShared({ allowDuringMode: true });
        } catch (error) {
          modeStatus = 'failed';
          noteAuth(error);
          showMessage({ source: 'press', text: explainError(error, appKeyRef.current) });
        } finally {
          closed = true;
          clearInterval(poll);
          modeSessionRef.current = idleModeSession();
          await finishModeSession(modeStatus, stateRef.current.systemMode);
        }
        return;
      }
      cancelRef.current = false;
      interruptRef.current = false;
      showMessage(null);
      let modeStatus: CommandEndStatus = 'failed';
      try {
        const settled = await runModeSession({
          from: snapshot.systemMode,
          target,
          step: snapshot.settings.modeStep,
          source: { kind: 'set-mode' },
          delayMs: snapshot.settings.delayMs,
          press: pressMode,
          sleep: (ms, isCancelled) => sleepUnless(ms, isCancelled),
          beforeSend: async (index, isCancelled) => {
            if (index === 0) {
              return sleepUnless(FIRST_ARM_MS, isCancelled);
            }
            return isCancelled();
          },
          isCancelled: () => cancelRef.current,
          isInterrupted: () => interruptRef.current,
          onSession: (session) => {
            modeSessionRef.current = session;
            const progress = modeProgress(session);
            if (progress) {
              showModeProgress(progress);
            }
          },
          onCommitted: (mode) => {
            const at = new Date().toISOString();
            commit((prev) => {
              const climate = reduceClimate(climateOf(prev), { type: 'recalibrate-mode', mode });
              return appendLog(
                applyClimate(prev, climate.state),
                'press',
                `Mode bot press. The thermostat is ${modeLabel(mode)}.`,
                at,
              );
            });
            pressFeedback();
          },
        });
        modeStatus = settled.status;
        if (settled.status === 'ambiguous') {
          showMessage({ source: 'press', text: CHECK_THERMOSTAT });
          errorFeedback();
        } else if (settled.reason && settled.status !== 'done' && settled.status !== 'already') {
          showMessage({ source: 'press', text: settled.reason });
          if (settled.status === 'failed' || settled.status === 'refused') {
            errorFeedback();
          }
        } else if (settled.status === 'done') {
          successFeedback();
        }
      } catch (error) {
        modeStatus = 'failed';
        showMessage({ source: 'press', text: explainError(error) });
        errorFeedback();
      } finally {
        modeSessionRef.current = idleModeSession();
        await finishModeSession(modeStatus, stateRef.current.systemMode);
      }
    },
    [clearDebounceTimer, commit, finishModeSession, noteAuth, pressMode, pullShared, sessionAuth, showMessage, showModeProgress],
  );

  useEffect(() => {
    setSystemModeRef.current = setSystemMode;
  }, [setSystemMode]);

  const value = useMemo<AppContextValue>(() => {
    return {
      ready,
      state,
      clock,
      command,
      desiredSetpoint: desired,
      queuedTarget,
      queuedMode,
      banner: message?.text ?? connectionBanner(connection),
      refresh: refresh.phase,
      devices,
      deviceMessage,
      hasCredentials,
      tokenMask,
      secretMask,
      serverConfigured,
      access,
      gateNote,
      submitAppKey: async (value) => {
        const trimmed = value.trim();
        if (!trimmed) {
          return;
        }
        const config = readServerConfig();
        if (!config) {
          return;
        }
        setGateNote(null);
        applyAccess({ type: 'submit' });
        try {
          const snap = await fetchState(config, trimmed);
          await saveAppKey(trimmed);
          appKeyRef.current = trimmed;
          resetSync(syncRef.current);
          acceptVersion(syncRef.current, snap.version);
          applyAccess({ type: 'accepted' });
          if (stateRef.current.mode === 'live') {
            commit((prev) => applySnapshot(prev, snap));
          }
        } catch (error) {
          if (error instanceof ServerAuthError) {
            applyAccess({ type: 'rejected' });
            return;
          }
          applyAccess({ type: 'unreachable' });
          setGateNote("Couldn't reach the shared server. Try the key again.");
        }
      },
      clearAppKey: async () => {
        await deleteAppKey();
        appKeyRef.current = '';
        setGateNote(null);
        applyAccess({ type: 'clear' });
      },
      changeAppKey: () => {
        setGateNote(null);
        applyAccess({ type: 'change' });
      },
      clearBanner: () => {
        showMessage(null);
        if (connectionRef.current.status === 'down') {
          applyConnection({ type: 'dismiss' });
        }
      },
      setMode: (mode) => {
        if (isRunning(sessionRef.current) || isModeRunning(modeSessionRef.current)) {
          showMessage({ source: 'press', text: 'Finish the press before changing mode.' });
          return;
        }
        commit((prev) => ({ ...prev, mode }));
        if (mode === 'live') {
          void pullShared();
        }
      },
      setRoomLabel: (label) => {
        commitShared((prev) => ({ ...prev, roomLabel: label }));
      },
      updateSettings: (patch) => {
        commitShared((prev) => {
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
        const auth = sessionAuth();
        if (readServerConfig()) {
          if (!auth) {
            return 'Enter the app key before saving credentials.';
          }
          if (trimmedToken || trimmedSecret) {
            if (!trimmedToken || !trimmedSecret) {
              return 'Enter both the token and the secret.';
            }
            try {
              await saveRemoteCredentials(auth.config, auth.appKey, trimmedToken, trimmedSecret);
              await saveCredentials(trimmedToken, trimmedSecret);
              setHasCredentials(true);
              setTokenMask(maskSecret(trimmedToken));
              setSecretMask(maskSecret(trimmedSecret));
            } catch (error) {
              noteAuth(error);
              return explainError(error, appKeyRef.current);
            }
          }
          const error = await refreshDevices();
          if (!error) {
            commit((prev) => ({ ...prev, mode: 'live' }));
          }
          return error;
        }
        if (!trimmedToken || !trimmedSecret) {
          return 'Enter both the token and the secret.';
        }
        await saveCredentials(trimmedToken, trimmedSecret);
        setHasCredentials(true);
        setTokenMask(maskSecret(trimmedToken));
        setSecretMask(maskSecret(trimmedSecret));
        const error = await refreshDevices();
        if (!error) {
          commit((prev) => ({ ...prev, mode: 'live' }));
        }
        return error;
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
        if (!device) {
          commitShared((prev) => ({
            ...prev,
            deviceMap: { ...prev.deviceMap, [role]: null },
          }));
          return;
        }
        const picked = chooseDevice(stateRef.current.deviceMap, role, {
          deviceId: device.deviceId,
          deviceType: device.deviceType,
          deviceName: device.deviceName,
        });
        if (picked.status === 'rejected') {
          setDeviceMessage(picked.message);
          return;
        }
        setDeviceMessage(null);
        commitShared((prev) => ({
          ...prev,
          deviceMap: { ...prev.deviceMap, [role]: deviceFromApi(device) },
        }));
      },
      completeCalibration: (temp) => {
        const at = new Date().toISOString();
        const seeded = seedDemoHistory(new Date());
        commit((prev) => {
          const climate = reduceClimate(climateOf(prev), { type: 'seed', degrees: temp });
          const next = climate.reason ? prev : applyClimate(prev, climate.state);
          return appendLog(
            {
              ...next,
              catchupFrom: at,
              history: prev.history.length > 0 ? prev.history : seeded.history,
              changes:
                prev.changes.length > 0
                  ? prev.changes
                  : [...seeded.changes, { at, setpoint: temp, source: 'manual', label: `Calibrated · ${temp}°` }],
            },
            'calibration',
            `Saved ${temp}° for both Heat and Cool. No buttons were pressed. Tell Setpoint which mode the thermostat is in.`,
            at,
          );
        });
        const auth = sessionAuth();
        if (auth && stateRef.current.mode === 'live') {
          void saveState(auth.config, auth.appKey, snapshotFrom(stateRef.current, syncRef.current.version))
            .then((saved) => {
              acceptVersion(syncRef.current, saved.version);
            })
            .catch((error) => {
              noteAuth(error);
            });
        }
      },
      recalibrate: async (write) => {
        const snapshot = stateRef.current;
        const change: RecalibrateWrite = {
          mode: write.mode !== null && write.mode !== snapshot.systemMode ? write.mode : null,
          heat: write.heat !== null && write.heat !== snapshot.heatSetpoint ? write.heat : null,
          cool: write.cool !== null && write.cool !== snapshot.coolSetpoint ? write.cool : null,
        };
        if (change.mode === null && change.heat === null && change.cool === null) {
          return null;
        }
        if (snapshot.systemMode === 'unknown' && change.mode === null) {
          return PICK_MODE_REASON;
        }
        if (isRunning(sessionRef.current) || isModeRunning(modeSessionRef.current)) {
          return 'Wait for the press to finish before recalibrating.';
        }
        const range = snapshot.settings;
        for (const degrees of [change.heat, change.cool]) {
          if (degrees === null) {
            continue;
          }
          if (!Number.isInteger(degrees)) {
            return 'Temperatures are whole degrees.';
          }
          if (degrees < range.minF || degrees > range.maxF) {
            return `${degrees}° is outside ${range.minF}-${range.maxF}°. Widen the range or pick a temperature inside it.`;
          }
        }
        const auth = sessionAuth();
        if (!auth || snapshot.mode !== 'live') {
          commit((prev) => recordRecalibration(prev, change, new Date().toISOString()));
          return null;
        }
        const sync = syncRef.current;
        sync.recalibrating = true;
        try {
          const saved = await recalibrateRemote(auth.config, auth.appKey, {
            ...(change.mode ? { mode: change.mode } : {}),
            ...(change.heat !== null ? { heatF: change.heat } : {}),
            ...(change.cool !== null ? { coolF: change.cool } : {}),
          });
          acceptVersion(sync, saved.version);
          commit((prev) => recordRecalibration(prev, appliedWrite(prev, saved), new Date().toISOString()));
          return null;
        } catch (error) {
          if (noteAuth(error)) {
            return 'The app key was rejected.';
          }
          return explainError(error, appKeyRef.current);
        } finally {
          sync.recalibrating = false;
        }
      },
      bump: async (direction) => {
        const snapshot = stateRef.current;
        const runningMode = isModeRunning(modeSessionRef.current) ? modeSessionRef.current.target : null;
        const base = bumpBaseForMode({
          runningMode,
          systemMode: snapshot.systemMode,
          heatSetpoint: snapshot.heatSetpoint,
          coolSetpoint: snapshot.coolSetpoint,
        });
        if (base.status !== 'active') {
          showMessage({ source: 'press', text: base.reason });
          errorFeedback();
          return;
        }
        if (queuedTargetRef.current !== null) {
          clearQueuedTarget();
        }
        const setpoint = base.degrees;
        const limits: StepLimits = {
          step: snapshot.settings.step,
          min: snapshot.settings.minF,
          max: snapshot.settings.maxF,
          pressCap: snapshot.settings.pressCap,
          wakeFirst: snapshot.settings.wakeFirst,
        };
        applyPending({ type: 'bump', direction, setpoint, limits });
      },
      setTo: (target) => runTarget(target, { kind: 'set-to' }),
      applyPreset: async (preset) => {
        await runTarget(preset.tempF, { kind: 'preset', label: preset.label });
      },
      setSystemMode: (mode) => setSystemMode(mode),
      cancelCommand: () => {
        applyPending({ type: 'cancel' });
        clearQueuedTarget();
        clearQueuedMode();
        cancelRef.current = true;
        const auth = sessionAuth();
        if (auth && stateRef.current.mode === 'live') {
          void cancelRemotePress(auth.config, auth.appKey).catch((error) => {
            noteAuth(error);
          });
        }
      },
      refreshClimate,
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
      setLoseNext: (value) => {
        commit((prev) => ({
          ...prev,
          demoClimate: { ...prev.demoClimate, loseNextResponse: value },
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
        commitShared((prev) => ({
          ...prev,
          presets: prev.presets.map((preset) => (preset.id === id ? { ...preset, ...patch } : preset)),
        }));
      },
      saveEvent: (event) => {
        const at = new Date().toISOString();
        commitShared((prev) => {
          const previous = prev.events.find((item) => item.id === event.id) ?? null;
          const exists = Boolean(previous);
          const events = exists ? prev.events.map((item) => (item.id === event.id ? event : item)) : [...prev.events, event];
          const reset = previous ? scheduleEditResetsCursor(previous, event) : false;
          return appendLog(
            {
              ...prev,
              events,
              catchupFrom: prev.virtualSetpoint === null ? prev.catchupFrom : reset ? at : prev.catchupFrom,
            },
            'schedule',
            `Updated ${event.label} · ${formatClock(event.hour, event.minute)} · ${event.targetF}°${event.mode ? ` · ${modeLabel(event.mode)}` : ''}.`,
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
        commitShared((prev) =>
          appendLog(
            { ...prev, events: [...prev.events, event] },
            'schedule',
            'Added Custom.',
            at,
          ),
        );
      },
      deleteEvent: (id) => {
        const at = new Date().toISOString();
        commitShared((prev) => {
          const event = prev.events.find((item) => item.id === id);
          return appendLog(
            { ...prev, events: prev.events.filter((item) => item.id !== id) },
            'schedule',
            `Removed ${event?.label ?? 'event'}.`,
            at,
          );
        });
      },
      restoreDefaults: () => {
        const at = new Date().toISOString();
        commitShared((prev) =>
          appendLog(
            { ...prev, events: defaultEvents(), catchupFrom: prev.virtualSetpoint === null ? prev.catchupFrom : at },
            'schedule',
            'Restored the default schedule.',
            at,
          ),
        );
      },
      resumeSchedule: async () => {
        if (isRunning(sessionRef.current) || isModeRunning(modeSessionRef.current)) {
          resumeAfterRef.current = true;
          showMessage({ source: 'schedule', text: 'Resume will apply when this press finishes.' });
          return;
        }
        await finishResume();
      },
      applyCancelled: async (key) => {
        const record = stateRef.current.records.find((item) => item.key === key);
        if (!record) {
          return;
        }
        const result = await runTarget(record.targetF, { kind: 'apply-now' });
        if (result.status === 'done' || result.status === 'already') {
          const at = new Date().toISOString();
          commitShared((prev) => ({
            ...prev,
            records: prev.records.map((item) =>
              item.key === key
                ? {
                    ...item,
                    status: result.status === 'already' ? 'already' : 'done-late',
                    via: 'apply-now',
                    message: `Applied ${record.label} at ${record.targetF}°.`,
                    recordedAt: at,
                  }
                : item,
            ),
          }));
        }
      },
      allowReminders: async () => {
        const note = await requestReminderPermission();
        await syncReminders(stateRef.current.events, new Date());
        return note;
      },
      skipNext: (eventId) => {
        const now = new Date();
        const occurrence = nextSkippable(stateRef.current.events, stateRef.current.records, eventId, now);
        if (!occurrence) {
          showMessage({ source: 'schedule', text: 'Nothing coming up to skip.' });
          return;
        }
        const applied = applyTransition(stateRef.current.records, occurrence, { type: 'skip' }, now.toISOString());
        if ('error' in applied) {
          showMessage({ source: 'schedule', text: applied.error });
          return;
        }
        commitShared((prev) =>
          appendLog(
            { ...prev, records: applied.records },
            'schedule',
            `Skipped the next ${occurrence.label}.`,
            now.toISOString(),
          ),
        );
      },
      skipOnDate: (eventId, day) => {
        const occurrence = occurrenceOnDate(stateRef.current.events, eventId, day);
        if (!occurrence) {
          showMessage({ source: 'schedule', text: 'That event does not run on the chosen day.' });
          return;
        }
        const applied = applyTransition(stateRef.current.records, occurrence, { type: 'skip' }, new Date().toISOString());
        if ('error' in applied) {
          showMessage({ source: 'schedule', text: applied.error });
          return;
        }
        commitShared((prev) =>
          appendLog({ ...prev, records: applied.records }, 'schedule', `Skipped ${occurrence.label} on ${day}.`, new Date().toISOString()),
        );
      },
      undoOccurrence: async (key) => {
        const record = stateRef.current.records.find((item) => item.key === key);
        if (!record) {
          return;
        }
        const occurrence = {
          key: record.key,
          eventId: record.eventId,
          label: record.label,
          targetF: record.targetF,
          at: record.occurrenceAt,
        };
        if (record.status === 'skipped') {
          const applied = applyTransition(stateRef.current.records, occurrence, { type: 'undo-skip' }, new Date().toISOString());
          if ('error' in applied) {
            showMessage({ source: 'schedule', text: applied.error });
            return;
          }
          commitShared((prev) =>
            appendLog({ ...prev, records: applied.records }, 'schedule', `Restored ${record.label}.`, new Date().toISOString()),
          );
          return;
        }
        if ((record.status === 'done-early' || record.status === 'done-late') && record.via === 'run-now') {
          const back = record.previousSetpoint;
          if (typeof back === 'number' && back !== stateRef.current.virtualSetpoint) {
            const result = await runTarget(back, { kind: 'apply-now' });
            if (result.status !== 'done' && result.status !== 'already') {
              return;
            }
          }
          const applied = applyTransition(stateRef.current.records, occurrence, { type: 'undo-run-now' }, new Date().toISOString());
          if ('error' in applied) {
            showMessage({ source: 'schedule', text: applied.error });
            return;
          }
          commitShared((prev) =>
            appendLog({ ...prev, records: applied.records }, 'schedule', `Undid ${record.label}.`, new Date().toISOString()),
          );
        }
      },
      runEventNow: async (eventId) => {
        const now = new Date();
        const occurrence = occurrenceForRunNow(stateRef.current.events, eventId, now);
        if (!occurrence) {
          showMessage({ source: 'schedule', text: 'That event has no occurrence to run.' });
          return;
        }
        const previous = stateRef.current.virtualSetpoint;
        const result = await runTarget(occurrence.targetF, {
          kind: 'run-now',
          eventId,
          label: occurrence.label,
          occurrenceKey: occurrence.key,
        });
        if (result.status !== 'done' && result.status !== 'already') {
          return;
        }
        const when = now.getTime() < Date.parse(occurrence.at) ? 'early' : 'late';
        const applied = applyTransition(
          stateRef.current.records,
          occurrence,
          { type: 'run-now', when },
          now.toISOString(),
          {
            via: 'run-now',
            previousSetpoint: previous ?? undefined,
            message:
              when === 'early'
                ? `${occurrence.label} ran early at ${occurrence.targetF}°.`
                : `${occurrence.label} ran late at ${occurrence.targetF}°.`,
          },
        );
        if ('error' in applied) {
          return;
        }
        commitShared((prev) => ({ ...prev, records: applied.records, hold: null }));
      },
      retrySchedule: async () => {
        if (schedulerBlocked(pendingRef.current) || isRunning(sessionRef.current) || isModeRunning(modeSessionRef.current)) {
          return;
        }
        const now = new Date();
        const snapshot = stateRef.current;
        if (snapshot.virtualSetpoint === null) {
          return;
        }
        const chip = chipFor({
          setpoint: snapshot.virtualSetpoint,
          hold: snapshot.hold,
          events: snapshot.events,
          records: snapshot.records,
          now,
        });
        if (chip.kind !== 'off-schedule') {
          return;
        }
        const result = await runTarget(chip.targetF, { kind: 'retry' });
        if (result.status !== 'done' && result.status !== 'already') {
          return;
        }
        const intended = intendedTarget(snapshot.events, stateRef.current.records, now);
        if (!intended) {
          return;
        }
        const applied = applyTransition(
          stateRef.current.records,
          intended,
          { type: 'retry', result: result.status === 'already' ? 'already' : 'done-late' },
          now.toISOString(),
          { via: 'retry', message: `Retried ${intended.label} at ${intended.targetF}°.` },
        );
        if (!('error' in applied)) {
          commitShared((prev) => ({ ...prev, records: applied.records }));
        }
      },
      loadHistoryWindow: async (window, current) => {
        const auth = sessionAuth();
        if (!auth || stateRef.current.mode !== 'live') {
          return localWindowData(stateRef.current.history, stateRef.current.changes, window);
        }
        try {
          return await fetchHistoryWindow(auth.config, auth.appKey, window, current);
        } catch (error) {
          throw new Error(noteAuth(error) ? 'The app key was rejected.' : explainError(error, appKeyRef.current));
        }
      },
      loadChangesPage: async (cursor, limit) => {
        const auth = sessionAuth();
        if (!auth || stateRef.current.mode !== 'live') {
          return pageLocalChanges(stateRef.current.changes, cursor, limit);
        }
        try {
          return await fetchChangePage(auth.config, auth.appKey, cursor, limit);
        } catch (error) {
          throw new Error(noteAuth(error) ? 'The app key was rejected.' : explainError(error, appKeyRef.current));
        }
      },
      meterImport,
      openMeterImport: () => {
        applyMeterImport({ type: 'pick' });
      },
      cancelMeterImport: () => {
        applyMeterImport({ type: 'cancel' });
      },
      dismissMeterImport: () => {
        applyMeterImport({ type: 'dismiss' });
      },
      failMeterImport: (message) => {
        applyMeterImport({ type: 'fail', message });
      },
      submitMeterCsv: async (csv) => {
        const next = applyMeterImport({ type: 'chosen' });
        if (next.status !== 'uploading') {
          return;
        }
        try {
          const parsed = parseMeterCsv(csv);
          if (!parsed.ok) {
            applyMeterImport({ type: 'fail', message: parsed.error });
            return;
          }
          const auth = sessionAuth();
          if (auth && stateRef.current.mode === 'live') {
            const summary = await importMeterCsvRemote(auth.config, auth.appKey, csv);
            applyMeterImport({ type: 'succeed', summary });
            return;
          }
          const merged = mergeMeterHistory(stateRef.current.history, parsed.rows, parsed.skipped);
          const history =
            merged.history.length > LOCAL_HISTORY_CAP
              ? merged.history.slice(merged.history.length - LOCAL_HISTORY_CAP)
              : merged.history;
          commit((prev) => ({ ...prev, history }));
          applyMeterImport({ type: 'succeed', summary: merged.summary });
        } catch (error) {
          const message = noteAuth(error) ? 'The app key was rejected.' : explainError(error, appKeyRef.current);
          applyMeterImport({ type: 'fail', message });
        }
      },
    };
  }, [
    ready,
    state,
    clock,
    command,
    desired,
    queuedTarget,
    queuedMode,
    message,
    connection,
    refresh,
    devices,
    deviceMessage,
    hasCredentials,
    tokenMask,
    secretMask,
    serverConfigured,
    access,
    gateNote,
    meterImport,
    applyAccess,
    applyConnection,
    applyMeterImport,
    sessionAuth,
    noteAuth,
    showMessage,
    commit,
    commitShared,
    pullShared,
    refreshDevices,
    refreshClimate,
    applyPending,
    clearQueuedTarget,
    clearQueuedMode,
    runTarget,
    finishResume,
    setSystemMode,
  ]);

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

function sleepUnless(ms: number, isCancelled: () => boolean): Promise<boolean> {
  if (ms <= 0) {
    return Promise.resolve(isCancelled());
  }
  return new Promise((resolve) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (isCancelled()) {
        clearInterval(timer);
        resolve(true);
        return;
      }
      if (Date.now() - started >= ms) {
        clearInterval(timer);
        resolve(false);
      }
    }, 40);
  });
}

export function useApp(): AppContextValue {
  const value = useContext(AppContext);
  if (!value) {
    throw new Error('useApp must be used inside AppProvider');
  }
  return value;
}

function serverClimateEmpty(snap: { heatSetpoint: number | null; coolSetpoint: number | null }): boolean {
  return snap.heatSetpoint === null && snap.coolSetpoint === null;
}

function modeCommandProgress(progress: { index: number; total: number; target: KnownMode; label: 'press' | 'finishing' }): CommandProgress {
  return {
    index: progress.index,
    total: progress.total,
    target: 0,
    label: progress.label,
    kind: 'mode',
    systemMode: progress.target,
  };
}

export function suggestedTarget(state: Persisted): number {
  if (state.virtualSetpoint === null) {
    return state.settings.minF;
  }
  return nearestTarget(state.virtualSetpoint, state.settings.step, state.settings.minF, state.settings.maxF);
}
