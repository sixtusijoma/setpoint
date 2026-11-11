import { BROWSER_BLOCKED, CHECK_THERMOSTAT } from '@/copy';
import { co2ForBand, type Co2Tone } from '@/domain/co2';
import { deriveLink, mapRejection } from '@/domain/link';
import { reduceLifecycle, type Lifecycle } from '@/domain/lifecycle';
import { pushMessage, type AppMessage } from '@/domain/messages';
import { applyTransition, nextSkippable, occurrenceForRunNow, occurrenceOnDate } from '@/domain/occurrences';
import { nearestTarget, planSetTo } from '@/domain/planSetTo';
import {
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
  scheduleEditResetsCursor,
  type ScheduleEvent,
} from '@/domain/schedule';
import { runDueSchedule } from '@/domain/scheduleRunner';
import { writeSetpoint } from '@/domain/setpoint';
import { formatClock } from '@/domain/time';
import { seedDemoHistory } from '@/domain/history';
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
  fetchHistory,
  fetchRemoteDevices,
  fetchRemoteSession,
  fetchState,
  readServerConfig,
  requestRemoteMeter,
  runRemotePress,
  saveRemoteCredentials,
  saveState,
  ServerAuthError,
  type ServerConfig,
  type SharedSnapshot,
} from '@/server/appClient';
import { deleteAppKey, loadAppKey, saveAppKey } from '@/storage/appKey';
import { clearCredentials, loadCredentials, maskSecret, saveCredentials } from '@/storage/credentials';
import { loadPersisted, savePersisted } from '@/storage/persist';
import {
  appendLog,
  createDefaultState,
  createId,
  deviceFromApi,
  reduceAppAccess,
  type AppAccess,
  type AppAccessEvent,
  type Persisted,
  type Preset,
} from '@/state/model';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AppState, Platform, type AppStateStatus } from 'react-native';

const FIRST_ARM_MS = 800;
const DEMO_PRESS_MS = 1200;

export type CommandProgress = {
  index: number;
  total: number;
  target: number;
  label: 'press' | 'finishing';
};

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
  banner: string | null;
  refreshing: boolean;
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
  mapRole: (role: 'up' | 'down' | 'meter', device: SwitchBotDevice | null) => void;
  completeCalibration: (temp: number) => void;
  recalibrate: (temp: number) => string | null;
  bump: (direction: 1 | -1) => Promise<void>;
  setTo: (target: number) => Promise<CommandResult>;
  applyPreset: (preset: Preset) => Promise<void>;
  cancelCommand: () => void;
  refreshClimate: () => Promise<void>;
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
  loadHistory: (span: 'day' | 'week') => Promise<void>;
};

const AppContext = createContext<AppContextValue | null>(null);

function explainError(error: unknown, secret = ''): string {
  let text = 'Something went wrong.';
  if (error instanceof ServerAuthError) {
    text = error.message;
  } else if (Platform.OS === 'web' && (error instanceof TransportError || isFetchFailure(error))) {
    text = BROWSER_BLOCKED;
  } else if (error instanceof Error && error.message) {
    text = error.message;
  }
  if (secret && text.includes(secret)) {
    return 'Something went wrong.';
  }
  return text;
}

function isFetchFailure(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return /failed to fetch|network request failed|load failed/i.test(error.message);
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

function snapshotFrom(state: Persisted, version: number): SharedSnapshot {
  return {
    version,
    virtualSetpoint: state.virtualSetpoint,
    catchupFrom: state.catchupFrom,
    mode: 'live',
    hold: state.hold,
    settings: state.settings,
    deviceMap: state.deviceMap,
    presets: state.presets,
    events: state.events,
    records: state.records,
    schedulePhase: state.schedulePhase,
    catchupNote: state.catchupNote,
    roomLabel: state.roomLabel,
  };
}

function applySnapshot(prev: Persisted, snap: SharedSnapshot): Persisted {
  return {
    ...prev,
    virtualSetpoint: snap.virtualSetpoint,
    catchupFrom: snap.catchupFrom,
    hold: snap.hold,
    settings: { ...prev.settings, ...snap.settings },
    deviceMap: snap.deviceMap,
    presets: snap.presets,
    events: snap.events,
    records: snap.records,
    schedulePhase: snap.schedulePhase,
    catchupNote: snap.catchupNote,
    roomLabel: snap.roomLabel || prev.roomLabel,
    mode: 'live',
  };
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<Persisted>(() => createDefaultState(new Date().toISOString()));
  const [ready, setReady] = useState(false);
  const [clock, setClock] = useState(() => new Date());
  const [command, setCommand] = useState<CommandProgress | null>(null);
  const [message, setMessage] = useState<AppMessage>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [devices, setDevices] = useState<SwitchBotDevice[]>([]);
  const [deviceMessage, setDeviceMessage] = useState<string | null>(null);
  const [hasCredentials, setHasCredentials] = useState(false);
  const [tokenMask, setTokenMask] = useState<string | null>(null);
  const [secretMask, setSecretMask] = useState<string | null>(null);
  const [serverConfigured] = useState(() => readServerConfig() !== null);
  const [access, setAccess] = useState<AppAccess>({ status: 'unused' });
  const [gateNote, setGateNote] = useState<string | null>(null);
  const stateRef = useRef(state);
  const appKeyRef = useRef('');
  const accessRef = useRef<AppAccess>({ status: 'unused' });
  const messageRef = useRef<AppMessage>(null);
  const cancelRef = useRef(false);
  const interruptRef = useRef(false);
  const sessionRef = useRef<PressSession>(idleSession());
  const resumeAfterRef = useRef(false);
  const refreshingRef = useRef(false);
  const tickLock = useRef(false);
  const tickImpl = useRef<(now: Date) => Promise<void>>(async () => undefined);
  const lifecycleRef = useRef<Lifecycle>({ kind: 'boot' });
  const saveChain = useRef<Promise<void>>(Promise.resolve());
  const saveLatest = useRef<Persisted | null>(null);
  const pushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const serverVersion = useRef(0);
  const pullSharedRef = useRef<() => Promise<void>>(async () => undefined);

  const showMessage = useCallback((next: AppMessage) => {
    const merged = next === null ? null : pushMessage(messageRef.current, next);
    messageRef.current = merged;
    setMessage(merged);
  }, []);

  const applyAccess = useCallback((event: AppAccessEvent) => {
    const next = reduceAppAccess(accessRef.current, event);
    accessRef.current = next;
    setAccess(next);
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

  const commit = useCallback((recipe: (prev: Persisted) => Persisted) => {
    const next = recipe(stateRef.current);
    stateRef.current = next;
    setState(next);
  }, []);

  const pushShared = useCallback((next: Persisted) => {
    const auth = sessionAuth();
    if (!auth || next.mode !== 'live') {
      return;
    }
    if (pushTimer.current) {
      clearTimeout(pushTimer.current);
    }
    pushTimer.current = setTimeout(() => {
      void saveState(auth.config, auth.appKey, snapshotFrom(stateRef.current, serverVersion.current))
        .then((saved) => {
          serverVersion.current = saved.version;
          if (saved.virtualSetpoint !== stateRef.current.virtualSetpoint) {
            commit((prev) => ({ ...prev, virtualSetpoint: saved.virtualSetpoint }));
          }
        })
        .catch((error) => {
          if (noteAuth(error)) {
            return;
          }
          const text = explainError(error, appKeyRef.current);
          if (text.includes('Pull and retry')) {
            void pullSharedRef.current();
            return;
          }
          showMessage({ source: 'link', text });
        });
    }, 250);
  }, [commit, noteAuth, sessionAuth, showMessage]);

  const commitShared = useCallback(
    (recipe: (prev: Persisted) => Persisted) => {
      const next = recipe(stateRef.current);
      stateRef.current = next;
      setState(next);
      pushShared(next);
    },
    [pushShared],
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
        if (next.virtualSetpoint !== null && !next.catchupFrom) {
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
          serverVersion.current = snap.version;
          applyAccess({ type: 'accepted' });
          if (stateRef.current.mode === 'live') {
            if (snap.virtualSetpoint === null && stateRef.current.virtualSetpoint !== null) {
              const saved = await saveState(config, key, snapshotFrom(stateRef.current, serverVersion.current));
              serverVersion.current = saved.version;
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

  const pullShared = useCallback(async () => {
    const auth = sessionAuth();
    if (!auth || stateRef.current.mode !== 'live' || isRunning(sessionRef.current)) {
      return;
    }
    try {
      const snap = await fetchState(auth.config, auth.appKey);
      serverVersion.current = snap.version;
      if (snap.virtualSetpoint === null && stateRef.current.virtualSetpoint !== null) {
        const saved = await saveState(auth.config, auth.appKey, snapshotFrom(stateRef.current, serverVersion.current));
        serverVersion.current = saved.version;
        return;
      }
      commit((prev) => applySnapshot(prev, snap));
    } catch (error) {
      if (noteAuth(error)) {
        return;
      }
      showMessage({ source: 'link', text: explainError(error, appKeyRef.current) });
    }
  }, [commit, noteAuth, sessionAuth, showMessage]);

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

  const runTargetRef = useRef<(target: number, source: CommandSource) => Promise<CommandResult>>(async () => ({
    status: 'refused',
    stoppedAt: 0,
    wanted: 0,
  }));

  const runTarget = useCallback(
    async (target: number, source: CommandSource): Promise<CommandResult> => {
      if (isRunning(sessionRef.current)) {
        const stoppedAt = stateRef.current.virtualSetpoint ?? target;
        showMessage({ source: 'press', text: 'A command is already running.' });
        return { status: 'busy', stoppedAt, wanted: target, reason: 'A command is already running.' };
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
          showMessage({ source: 'press', text: plan.reason });
          errorFeedback();
        }
        return { status: 'refused', stoppedAt: current, wanted: target, reason: plan.reason };
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
          showMessage({ source: 'link', text: reason });
        }
        return { status: 'refused', stoppedAt: current, wanted: target, reason };
      }
      if (link.kind === 'live' && link.phase === 'needs-bots') {
        const reason = 'Map the up bot and the down bot in Settings before sending presses.';
        if (source.kind !== 'schedule') {
          showMessage({ source: 'link', text: reason });
        }
        return { status: 'refused', stoppedAt: current, wanted: target, reason };
      }
      if (link.kind === 'live' && link.phase === 'ready' && link.cloud === 'off') {
        const reason = 'Cloud service is off. Turn it on in the SwitchBot app. Setpoint does not fall back to Bluetooth.';
        if (source.kind !== 'schedule') {
          showMessage({ source: 'link', text: reason });
        }
        return { status: 'refused', stoppedAt: current, wanted: target, reason };
      }
      if (plan.actions.length === 0) {
        if (source.kind !== 'schedule') {
          const at = new Date().toISOString();
          commit((prev) => appendLog(prev, 'schedule', `Already at ${target}°. No presses sent.`, at));
        }
        return { status: 'already', stoppedAt: current, wanted: target };
      }
      const auth = sessionAuth();
      if (snapshot.mode === 'live' && readServerConfig()) {
        if (!auth) {
          const reason = 'Enter the app key before sending a press.';
          if (source.kind !== 'schedule') {
            showMessage({ source: 'link', text: reason });
          }
          return { status: 'refused', stoppedAt: current, wanted: target, reason };
        }
        return runOnServer(auth, target, source);
      }
      cancelRef.current = false;
      interruptRef.current = false;
      if (source.kind !== 'schedule') {
        showMessage(null);
      }
      const settled = await runPressSession({
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
          setCommand(sessionProgress(session));
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
          commit((prev) =>
            appendLog(
              {
                ...prev,
                virtualSetpoint: setpoint,
                changes: [...prev.changes, { at, setpoint, source: mark.source, label: mark.label }].slice(-400),
              },
              'press',
              `${action.direction === 'up' ? 'Up bot' : 'Down bot'} press. Setpoint ${setpoint}°.`,
              at,
            ),
          );
          pressFeedback();
        },
      });
      sessionRef.current = idleSession();
      setCommand(null);
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
      if (resumeAfterRef.current) {
        resumeAfterRef.current = false;
        await finishResume();
      }
      return {
        status: settled.status === 'busy' ? 'busy' : settled.status,
        stoppedAt: settled.stoppedAt,
        wanted: settled.wanted,
        reason: settled.reason,
      };
    },
    [commit, commitShared, finishResume, hasCredentials, pressRole, serverConfigured, sessionAuth, showMessage],
  );

  async function runOnServer(
    auth: { config: ServerConfig; appKey: string },
    target: number,
    source: CommandSource,
  ): Promise<CommandResult> {
    sessionRef.current = {
      phase: 'armed',
      target,
      startedFrom: stateRef.current.virtualSetpoint ?? target,
      setpoint: stateRef.current.virtualSetpoint ?? target,
      actionIndex: 0,
      actions: [],
      source,
      mode: 'live',
      committedAdjusts: 0,
      cancelRequested: false,
    };
    const poll = setInterval(() => {
      void fetchRemoteSession(auth.config, auth.appKey)
        .then((remote) => {
          if (remote.progress) {
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
      clearInterval(poll);
      sessionRef.current = idleSession();
      setCommand(null);
    }
  }

  runTargetRef.current = runTarget;

  const tick = useCallback(
    async (now: Date) => {
      if (isRunning(sessionRef.current) || tickLock.current) {
        return;
      }
      const snapshot = stateRef.current;
      if (snapshot.virtualSetpoint === null) {
        return;
      }
      if (snapshot.mode === 'live' && readServerConfig()) {
        await pullShared();
        return;
      }
      tickLock.current = true;
      try {
        const outcome = await runDueSchedule({
          now,
          events: snapshot.events,
          records: snapshot.records,
          hold: snapshot.hold,
          setpoint: snapshot.virtualSetpoint,
          catchupFrom: snapshot.catchupFrom,
          retryFailed: snapshot.schedulePhase === 'armed',
          step: snapshot.settings.step,
          schedulePhase: snapshot.schedulePhase,
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
    [commitShared, pullShared, runTarget, showMessage],
  );

  tickImpl.current = tick;

  useEffect(() => {
    if (!ready || state.virtualSetpoint === null) {
      return;
    }
    void tickImpl.current(new Date());
    void refreshRef.current();
    const timer = setInterval(() => {
      void tickImpl.current(new Date());
    }, 5000);
    const onAppState = (status: AppStateStatus) => {
      if (status === 'active') {
        lifecycleRef.current = reduceLifecycle(lifecycleRef.current, 'foreground');
        commit((prev) => (prev.schedulePhase === 'armed' ? prev : { ...prev, schedulePhase: 'armed' }));
        void tickImpl.current(new Date());
        void refreshRef.current();
        return;
      }
      lifecycleRef.current = reduceLifecycle(lifecycleRef.current, 'background');
      if (isRunning(sessionRef.current)) {
        interruptRef.current = true;
        lifecycleRef.current = reduceLifecycle(lifecycleRef.current, 'press-interrupted');
      }
    };
    const subscription = AppState.addEventListener('change', onAppState);
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        lifecycleRef.current = reduceLifecycle(lifecycleRef.current, 'foreground');
        commit((prev) => (prev.schedulePhase === 'armed' ? prev : { ...prev, schedulePhase: 'armed' }));
        void tickImpl.current(new Date());
        void refreshRef.current();
        return;
      }
      lifecycleRef.current = reduceLifecycle(lifecycleRef.current, 'background');
      if (isRunning(sessionRef.current)) {
        interruptRef.current = true;
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
  }, [commit, ready, state.virtualSetpoint]);

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
    if (readServerConfig()) {
      if (!auth) {
        const note = 'Enter the app key before loading devices.';
        setDeviceMessage(note);
        return note;
      }
      try {
        const listed = await fetchRemoteDevices(auth.config, auth.appKey);
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
        setDeviceMessage(note);
        return note;
      }
    }
    const creds = await loadCredentials();
    if (!creds) {
      setDeviceMessage('Add a token and secret before loading devices.');
      return 'Add a token and secret before loading devices.';
    }
    try {
      const list = await listDevices(creds);
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
      setDeviceMessage(note);
      return note;
    }
  }, [noteAuth, sessionAuth]);

  const refreshClimate = useCallback(async () => {
    if (refreshingRef.current) {
      return;
    }
    refreshingRef.current = true;
    setRefreshing(true);
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
            ].slice(-2000),
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
        if (meter.sample) {
          commit((prev) => ({
            ...prev,
            lastLive: {
              temperatureF: meter.sample?.temperatureF ?? prev.lastLive?.temperatureF ?? 0,
              humidity: meter.sample?.humidity ?? 0,
              co2Ppm: meter.sample?.co2Ppm ?? 0,
              updatedAt: meter.sample?.at ?? nowIso,
              batteryUp: prev.lastLive?.batteryUp ?? null,
              batteryDown: prev.lastLive?.batteryDown ?? null,
              batteryMeter: prev.lastLive?.batteryMeter ?? null,
            },
            history: meter.sample ? [...prev.history, meter.sample].slice(-2000) : prev.history,
          }));
        }
        return;
      }
      const creds = await loadCredentials();
      if (!creds) {
        showMessage({ source: 'link', text: 'Add a SwitchBot token and secret in Settings.' });
        return;
      }
      if (!snapshot.deviceMap.meter) {
        showMessage({ source: 'meter', text: 'Map the Meter in Settings to read the room.' });
        return;
      }
      const meter = await readMeter(creds, snapshot.deviceMap.meter.id);
      let batteryUp: number | null = null;
      let batteryDown: number | null = null;
      try {
        batteryUp = snapshot.deviceMap.up ? await readBotBattery(creds, snapshot.deviceMap.up.id) : null;
        batteryDown = snapshot.deviceMap.down ? await readBotBattery(creds, snapshot.deviceMap.down.id) : null;
      } catch {
        batteryUp = snapshot.lastLive?.batteryUp ?? null;
        batteryDown = snapshot.lastLive?.batteryDown ?? null;
      }
      commit((prev) => ({
        ...prev,
        lastLive: {
          temperatureF: meter.temperatureF,
          humidity: meter.humidity,
          co2Ppm: meter.co2Ppm,
          updatedAt: nowIso,
          batteryUp,
          batteryDown,
          batteryMeter: meter.battery,
        },
        history: [
          ...prev.history,
          { at: nowIso, temperatureF: meter.temperatureF, humidity: meter.humidity, co2Ppm: meter.co2Ppm },
        ].slice(-2000),
      }));
    } catch (error) {
      if (!noteAuth(error)) {
        showMessage({ source: 'meter', text: explainError(error, appKeyRef.current) });
      }
    } finally {
      refreshingRef.current = false;
      setRefreshing(false);
    }
  }, [commit, noteAuth, sessionAuth, showMessage]);

  const refreshRef = useRef(refreshClimate);
  refreshRef.current = refreshClimate;

  const value = useMemo<AppContextValue>(() => {
    return {
      ready,
      state,
      clock,
      command,
      banner: message?.text ?? null,
      refreshing,
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
          serverVersion.current = snap.version;
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
      clearBanner: () => showMessage(null),
      setMode: (mode) => {
        if (isRunning(sessionRef.current)) {
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
        const rejection = mapRejection(role, device, stateRef.current.deviceMap);
        if (rejection) {
          setDeviceMessage(rejection);
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
        commit((prev) =>
          appendLog(
            {
              ...prev,
              virtualSetpoint: temp,
              catchupFrom: at,
              history: prev.history.length > 0 ? prev.history : seeded.history,
              changes:
                prev.changes.length > 0
                  ? prev.changes
                  : [...seeded.changes, { at, setpoint: temp, source: 'manual', label: `Calibrated · ${temp}°` }],
            },
            'calibration',
            `Calibrated the virtual setpoint to ${temp}°. No buttons were pressed.`,
            at,
          ),
        );
      },
      recalibrate: (temp) => {
        const session = sessionRef.current;
        const written = writeSetpoint(stateRef.current.virtualSetpoint, { degrees: temp, source: 'recalibrated' }, session);
        if (!written.ok) {
          showMessage({ source: 'press', text: written.reason });
          return written.reason;
        }
        const range = stateRef.current.settings;
        if (temp < range.minF || temp > range.maxF) {
          const reason = `${temp}° is outside ${range.minF}-${range.maxF}°. Widen the range or pick a temperature inside it.`;
          showMessage({ source: 'link', text: reason });
          return reason;
        }
        const at = new Date().toISOString();
        commitShared((prev) =>
          appendLog(
            {
              ...prev,
              virtualSetpoint: temp,
              changes: [...prev.changes, { at, setpoint: temp, source: 'manual', label: `Recalibrated · ${temp}°` }].slice(-400),
            },
            'calibration',
            `Recalibrated the virtual setpoint to ${temp}°. No buttons were pressed.`,
            at,
          ),
        );
        return null;
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
        if (isRunning(sessionRef.current)) {
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
      loadHistory: async (span) => {
        const auth = sessionAuth();
        if (!auth || stateRef.current.mode !== 'live') {
          return;
        }
        try {
          const history = await fetchHistory(auth.config, auth.appKey, span);
          commit((prev) => ({
            ...prev,
            history: history.samples,
            changes: history.changes,
          }));
        } catch (error) {
          if (!noteAuth(error)) {
            showMessage({ source: 'link', text: explainError(error, appKeyRef.current) });
          }
        }
      },
    };
  }, [
    ready,
    state,
    clock,
    command,
    message,
    refreshing,
    devices,
    deviceMessage,
    hasCredentials,
    tokenMask,
    secretMask,
    serverConfigured,
    access,
    gateNote,
    applyAccess,
    sessionAuth,
    noteAuth,
    showMessage,
    commit,
    commitShared,
    pullShared,
    refreshDevices,
    refreshClimate,
    runTarget,
    finishResume,
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

export function suggestedTarget(state: Persisted): number {
  if (state.virtualSetpoint === null) {
    return state.settings.minF;
  }
  return nearestTarget(state.virtualSetpoint, state.settings.step, state.settings.minF, state.settings.maxF);
}
