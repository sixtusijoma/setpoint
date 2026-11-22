import { reduceBatteryFetch, shouldFetchBatteries, stateFromCache, type BatteryReading } from '../domain/batteryFetch';
import { refusalFor, resolveActive } from '../domain/modeSetpoint';
import { PICK_MODE_REASON, recalibrateChangeLabel } from '../domain/recalibrateDraft';
import { modeProgress, runModeSession, type ModeSession, type ModeSource } from '../domain/modePress';
import type { Direction } from '../domain/planSetTo';
import { planSetTo } from '../domain/planSetTo';
import {
  runPressSession,
  sessionProgress,
  shouldStartHold,
  type CommandSource,
  type PressSession,
} from '../domain/pressSession';
import { isKnownMode, modeStepOf, type KnownMode, type SystemMode } from '../domain/systemMode';
import { holdFor, scheduleEditResetsCursor, type ScheduleEvent } from '../domain/schedule';
import { runDueSchedule } from '../domain/scheduleRunner';
import type { HistorySample } from '../domain/history';
import { SWITCHBOT_TIMEOUT_MS } from '../devices/switchbot';
import type { SetpointDb } from './sqlDb';
import type { CommandResult, ServerDeviceMap, SharedSnapshot } from './types';

const LEASE_SECONDS = 180;
const LEASE_POLL_MS = 250;

export const SERVER_WALL_CLOCK_MS = 150_000;
export const SERVER_TIME_MARGIN_MS = 20_000;
const workerStartedAt = Date.now();

export type PressTiming = {
  sleep?: (ms: number, isCancelled: () => boolean) => Promise<boolean>;
  clock?: () => number;
  deadlineAt?: number;
};

export function serverDeadline(startedAt: number = workerStartedAt): number {
  return startedAt + SERVER_WALL_CLOCK_MS - SERVER_TIME_MARGIN_MS;
}

function changeLabel(source: CommandSource, setpoint: number): { source: string; label: string } {
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

async function patchRetry(db: SetpointDb, patch: Record<string, unknown>): Promise<SharedSnapshot> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const state = await db.readState();
    const saved = await db.patchState(state.version, patch);
    if (saved) {
      return saved;
    }
  }
  throw new Error('Shared state changed while saving. Try again.');
}

export async function executeSharedPress(
  db: SetpointDb,
  input: {
    target: number;
    source: CommandSource;
    owner: string;
    now?: () => Date;
    armMs?: number;
    timing?: PressTiming;
    press: (direction: Direction, signal: AbortSignal) => Promise<void>;
  },
): Promise<CommandResult> {
  const now = input.now ?? (() => new Date());
  const acquired = await db.acquireLease(input.owner, LEASE_SECONDS);
  const initial = await db.readState();
  if (!acquired) {
    return {
      status: 'busy',
      stoppedAt: initial.virtualSetpoint ?? input.target,
      wanted: input.target,
      reason: 'A command is already running.',
      notifyCheck: false,
    };
  }
  let cancel = false;
  const poll = setInterval(() => {
    void db.readLease().then((lease) => {
      if (lease.cancelRequested) {
        cancel = true;
      }
    });
    void db.touchLease(input.owner, LEASE_SECONDS);
  }, LEASE_POLL_MS);
  try {
    const active = resolveActive(initial.systemMode, { heat: initial.heatSetpoint, cool: initial.coolSetpoint });
    if (active.status !== 'active') {
      return {
        status: 'refused',
        stoppedAt: input.target,
        wanted: input.target,
        reason: refusalFor(active) ?? 'Set the virtual setpoint first.',
        notifyCheck: false,
      };
    }
    if (initial.mode !== 'live') {
      return {
        status: 'refused',
        stoppedAt: active.degrees,
        wanted: input.target,
        reason: 'The shared server only presses in live mode.',
        notifyCheck: false,
      };
    }
    const plan = planSetTo({
      current: active.degrees,
      target: input.target,
      step: initial.settings.step,
      minF: initial.settings.minF,
      maxF: initial.settings.maxF,
      pressCap: initial.settings.pressCap,
      wakeFirst: initial.settings.wakeFirst,
    });
    const settled = await runPressSession({
      current: active.degrees,
      target: input.target,
      source: input.source,
      mode: 'live',
      plan,
      delayMs: initial.settings.delayMs,
      timeLimit: {
        endsAt: input.timing?.deadlineAt ?? serverDeadline(),
        perPressMs: SWITCHBOT_TIMEOUT_MS,
        now: input.timing?.clock ?? Date.now,
      },
      press: input.press,
      sleep: input.timing?.sleep ?? ((ms, isCancelled) => sleepUnless(ms, isCancelled)),
      beforeSend: async (index) => {
        if (index === 0 && (input.armMs ?? 0) > 0) {
          const started = Date.now();
          while (Date.now() - started < (input.armMs ?? 0)) {
            const lease = await db.readLease();
            if (lease.cancelRequested) {
              cancel = true;
              return true;
            }
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
        }
        const lease = await db.readLease();
        if (lease.cancelRequested) {
          cancel = true;
        }
        return cancel;
      },
      isCancelled: () => cancel,
      isInterrupted: () => false,
      onSession: (session: PressSession) => {
        const progress = sessionProgress(session);
        if (progress) {
          void db.writeProgress(input.owner, { ...progress, kind: 'setpoint' });
        }
      },
      onCommitted: async (action, setpoint) => {
        if (action.kind !== 'adjust') {
          return;
        }
        const mark = changeLabel(input.source, setpoint);
        await patchRetry(db, active.mode === 'heat' ? { heatSetpoint: setpoint } : { coolSetpoint: setpoint });
        await db.insertChange({
          at: now().toISOString(),
          setpoint,
          source: mark.source,
          label: mark.label,
        });
      },
    });
    if (shouldStartHold(input.source, settled)) {
      const latest = await db.readState();
      await db.patchState(latest.version, { hold: holdFor(latest.events, now()) });
    }
    return {
      status: settled.status,
      stoppedAt: settled.stoppedAt,
      wanted: settled.wanted,
      reason: settled.reason,
      notifyCheck: settled.notifyCheck,
    };
  } finally {
    clearInterval(poll);
    await db.releaseLease(input.owner);
  }
}

export async function runSchedulerTick(
  db: SetpointDb,
  input: {
    owner?: string;
    now?: () => Date;
    timing?: PressTiming;
    press: (direction: Direction, signal: AbortSignal) => Promise<void>;
  },
): Promise<{ apply: string | null; note: string | null }> {
  const now = input.now ?? (() => new Date());
  const state = await db.readState();
  const active = resolveActive(state.systemMode, { heat: state.heatSetpoint, cool: state.coolSetpoint });
  if (state.mode !== 'live' || active.status !== 'active') {
    return { apply: null, note: state.mode === 'live' ? refusalFor(active) : null };
  }
  const lease = await db.readLease();
  if (lease.phase === 'running' && lease.leaseUntil && Date.parse(lease.leaseUntil) > now().getTime()) {
    return { apply: null, note: null };
  }
  const outcome = await runDueSchedule({
    now: now(),
    events: state.events,
    records: state.records,
    hold: state.hold,
    setpoint: active.degrees,
    catchupFrom: state.catchupFrom,
    retryFailed: state.schedulePhase === 'armed',
    step: state.settings.step,
    schedulePhase: state.schedulePhase,
    execute: async (target) => {
      const result = await executeSharedPress(db, {
        target,
        source: { kind: 'schedule' },
        owner: input.owner ?? 'scheduler',
        now,
        timing: input.timing,
        press: input.press,
      });
      if (
        result.status === 'done' ||
        result.status === 'already' ||
        result.status === 'cancelled' ||
        result.status === 'busy' ||
        result.status === 'refused' ||
        result.status === 'ambiguous'
      ) {
        return result;
      }
      return { status: 'failed' as const, stoppedAt: result.stoppedAt, wanted: result.wanted, reason: result.reason };
    },
  });
  await patchRetry(db, {
    records: outcome.records,
    hold: outcome.hold,
    schedulePhase: outcome.schedulePhase,
    catchupNote: outcome.catchupNote,
  });
  const applied = outcome.records.find((record) => record.via === 'catch-up' || record.via === 'scheduler');
  return { apply: applied?.label ?? null, note: outcome.catchupNote };
}

export async function storeMeterRead(db: SetpointDb, sample: HistorySample): Promise<void> {
  await db.insertRead(sample);
}

function normalizeDays(days: number[] | undefined): number[] | undefined {
  if (days === undefined) {
    return undefined;
  }
  const next = [...new Set(days.map((day) => Number(day)))].sort((a, b) => a - b);
  if (next.length === 0 || next.some((day) => !Number.isInteger(day) || day < 1 || day > 7)) {
    throw new Error('Days must be Monday=1 through Sunday=7.');
  }
  return next;
}

function createdEvent(
  eventId: string,
  patch: Partial<Pick<ScheduleEvent, 'label' | 'hour' | 'minute' | 'targetF' | 'days' | 'enabled'>>,
): ScheduleEvent {
  if (
    !eventId ||
    typeof patch.label !== 'string' ||
    !patch.label.trim() ||
    typeof patch.hour !== 'number' ||
    typeof patch.minute !== 'number' ||
    typeof patch.targetF !== 'number' ||
    !patch.days
  ) {
    throw new Error('To add an event, provide label, hour, minute, targetF, and days.');
  }
  return {
    id: eventId,
    label: patch.label.trim(),
    hour: patch.hour,
    minute: patch.minute,
    targetF: patch.targetF,
    days: patch.days,
    enabled: patch.enabled ?? true,
  };
}

export async function editScheduleEvent(
  db: SetpointDb,
  eventId: string,
  patch: Partial<Pick<ScheduleEvent, 'label' | 'hour' | 'minute' | 'targetF' | 'days' | 'enabled'>>,
  now = new Date(),
): Promise<SharedSnapshot> {
  const state = await db.readState();
  const days = normalizeDays(patch.days);
  const clean: Partial<Pick<ScheduleEvent, 'label' | 'hour' | 'minute' | 'targetF' | 'days' | 'enabled'>> = {};
  if (typeof patch.label === 'string') {
    clean.label = patch.label;
  }
  if (typeof patch.hour === 'number') {
    clean.hour = patch.hour;
  }
  if (typeof patch.minute === 'number') {
    clean.minute = patch.minute;
  }
  if (typeof patch.targetF === 'number') {
    clean.targetF = patch.targetF;
  }
  if (days) {
    clean.days = days;
  }
  if (typeof patch.enabled === 'boolean') {
    clean.enabled = patch.enabled;
  }
  const current = state.events.find((event) => event.id === eventId);
  if (!current) {
    const created = createdEvent(eventId, clean);
    return patchRetry(db, {
      events: [...state.events, created],
      catchupFrom: state.catchupFrom,
    });
  }
  const next: ScheduleEvent = { ...current, ...clean, id: current.id };
  const events = state.events.map((event) => (event.id === eventId ? next : event));
  const reset = scheduleEditResetsCursor(current, next);
  return patchRetry(db, {
    events,
    catchupFrom: reset ? now.toISOString() : state.catchupFrom,
  });
}

export function deviceIds(map: ServerDeviceMap): { upId: string | null; downId: string | null; modeId: string | null } {
  return { upId: map.up?.id ?? null, downId: map.down?.id ?? null, modeId: map.mode?.id ?? null };
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
    }, 20);
  });
}

const RECALIBRATE_OWNER = 'recalibrate';
const RECALIBRATE_LEASE_SECONDS = 15;

export class RecalibrateError extends Error {
  constructor(
    message: string,
    readonly kind: 'invalid' | 'busy',
  ) {
    super(message);
    this.name = 'RecalibrateError';
  }
}

export type RecalibrateInput = {
  /** Legacy: correct only the active setpoint. Cannot be combined with mode, heatF, or coolF. */
  temperatureF?: unknown;
  mode?: unknown;
  heatF?: unknown;
  coolF?: unknown;
  now?: () => Date;
};

export type RecalibrateSaved = {
  previous: number | null;
  setpoint: number | null;
  systemMode: SystemMode;
  heatSetpoint: number | null;
  coolSetpoint: number | null;
  version: number;
};

function wholeDegrees(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new RecalibrateError('Temperatures are whole degrees.', 'invalid');
  }
  return value;
}

function outsideRange(degrees: number, minF: number, maxF: number): string | null {
  if (degrees < minF || degrees > maxF) {
    return `${degrees}° is outside ${minF}-${maxF}°. Widen the range or pick a temperature inside it.`;
  }
  return null;
}

function previousSetpoint(state: SharedSnapshot): number | null {
  const active = resolveActive(state.systemMode, { heat: state.heatSetpoint, cool: state.coolSetpoint });
  return active.status === 'active' ? active.degrees : null;
}

export async function recalibrateShared(db: SetpointDb, input: RecalibrateInput): Promise<RecalibrateSaved> {
  const now = input.now ?? (() => new Date());
  const explicit = input.mode !== undefined || input.heatF !== undefined || input.coolF !== undefined;
  if (explicit && input.temperatureF !== undefined) {
    throw new RecalibrateError('Pass temperatureF or the mode and setpoints, not both.', 'invalid');
  }
  let mode: KnownMode | undefined;
  let heat: number | undefined;
  let cool: number | undefined;
  let legacy: number | undefined;
  if (explicit) {
    if (input.mode !== undefined) {
      if (!isKnownMode(input.mode)) {
        throw new RecalibrateError('Mode must be heat, off, or cool.', 'invalid');
      }
      mode = input.mode;
    }
    if (input.heatF !== undefined) {
      heat = wholeDegrees(input.heatF);
    }
    if (input.coolF !== undefined) {
      cool = wholeDegrees(input.coolF);
    }
  } else {
    legacy = wholeDegrees(input.temperatureF);
  }
  const acquired = await db.acquireLease(RECALIBRATE_OWNER, RECALIBRATE_LEASE_SECONDS);
  if (!acquired) {
    throw new RecalibrateError('A press is running. Wait for it to finish before recalibrating.', 'busy');
  }
  try {
    const state = await db.readState();
    const { minF, maxF } = state.settings;
    const patch: Record<string, unknown> = {};
    const logs: { setpoint: number; label: string }[] = [];
    if (legacy !== undefined) {
      const active = resolveActive(state.systemMode, { heat: state.heatSetpoint, cool: state.coolSetpoint });
      if (active.status !== 'active' && active.status !== 'unset') {
        throw new RecalibrateError(refusalFor(active) ?? 'Set the virtual setpoint first.', 'invalid');
      }
      const range = outsideRange(legacy, minF, maxF);
      if (range) {
        throw new RecalibrateError(range, 'invalid');
      }
      if (active.status !== 'active' || active.degrees !== legacy) {
        patch[active.mode === 'heat' ? 'heatSetpoint' : 'coolSetpoint'] = legacy;
        logs.push({ setpoint: legacy, label: recalibrateChangeLabel(active.mode, legacy) });
      }
    } else {
      const nextMode = mode ?? state.systemMode;
      if (nextMode === 'unknown') {
        throw new RecalibrateError(PICK_MODE_REASON, 'invalid');
      }
      if (heat !== undefined) {
        const range = outsideRange(heat, minF, maxF);
        if (range) {
          throw new RecalibrateError(range, 'invalid');
        }
      }
      if (cool !== undefined) {
        const range = outsideRange(cool, minF, maxF);
        if (range) {
          throw new RecalibrateError(range, 'invalid');
        }
      }
      if (mode !== undefined && mode !== state.systemMode) {
        patch.systemMode = mode;
      }
      if (heat !== undefined && heat !== state.heatSetpoint) {
        patch.heatSetpoint = heat;
        logs.push({ setpoint: heat, label: recalibrateChangeLabel('heat', heat) });
      }
      if (cool !== undefined && cool !== state.coolSetpoint) {
        patch.coolSetpoint = cool;
        logs.push({ setpoint: cool, label: recalibrateChangeLabel('cool', cool) });
      }
    }
    const previous = previousSetpoint(state);
    const saved = Object.keys(patch).length === 0 ? state : await patchRetry(db, patch);
    const at = now().toISOString();
    for (const entry of logs) {
      await db.insertChange({ at, setpoint: entry.setpoint, source: 'recalibrated', label: entry.label });
    }
    return {
      previous,
      setpoint: saved.virtualSetpoint,
      systemMode: saved.systemMode,
      heatSetpoint: saved.heatSetpoint,
      coolSetpoint: saved.coolSetpoint,
      version: saved.version,
    };
  } finally {
    await db.releaseLease(RECALIBRATE_OWNER);
  }
}

const MODE_RECALIBRATE_OWNER = 'recalibrate-mode';

export type ModeCommandResult = {
  status: 'done' | 'already' | 'cancelled' | 'failed' | 'refused' | 'busy' | 'ambiguous';
  systemMode: SystemMode;
  wanted: KnownMode;
  reason?: string;
  notifyCheck: boolean;
};

export async function executeModePress(
  db: SetpointDb,
  input: {
    target: KnownMode;
    source: ModeSource;
    owner: string;
    now?: () => Date;
    timing?: PressTiming;
    press: (signal: AbortSignal) => Promise<void>;
  },
): Promise<ModeCommandResult> {
  const acquired = await db.acquireLease(input.owner, LEASE_SECONDS);
  const initial = await db.readState();
  if (!acquired) {
    return {
      status: 'busy',
      systemMode: initial.systemMode,
      wanted: input.target,
      reason: 'A command is already running.',
      notifyCheck: false,
    };
  }
  let cancel = false;
  const poll = setInterval(() => {
    void db.readLease().then((lease) => {
      if (lease.cancelRequested) {
        cancel = true;
      }
    });
    void db.touchLease(input.owner, LEASE_SECONDS);
  }, LEASE_POLL_MS);
  try {
    if (initial.mode !== 'live') {
      return {
        status: 'refused',
        systemMode: initial.systemMode,
        wanted: input.target,
        reason: 'The shared server only presses in live mode.',
        notifyCheck: false,
      };
    }
    const settled = await runModeSession({
      from: initial.systemMode,
      target: input.target,
      step: modeStepOf(initial.settings.modeStep),
      source: input.source,
      delayMs: initial.settings.delayMs,
      timeLimit: {
        endsAt: input.timing?.deadlineAt ?? serverDeadline(),
        perPressMs: SWITCHBOT_TIMEOUT_MS,
        now: input.timing?.clock ?? Date.now,
      },
      press: input.press,
      sleep: input.timing?.sleep ?? ((ms, isCancelled) => sleepUnless(ms, isCancelled)),
      beforeSend: async () => {
        const lease = await db.readLease();
        if (lease.cancelRequested) {
          cancel = true;
        }
        return cancel;
      },
      isCancelled: () => cancel,
      isInterrupted: () => false,
      onSession: (session: ModeSession) => {
        const progress = modeProgress(session);
        if (progress) {
          void db.writeProgress(input.owner, {
            index: progress.index,
            total: progress.total,
            target: 0,
            label: progress.label,
            kind: 'mode',
            systemMode: progress.target,
          });
        }
      },
      onCommitted: async (mode) => {
        await patchRetry(db, { systemMode: mode });
      },
    });
    return {
      status: settled.status,
      systemMode: settled.tracked,
      wanted: input.target,
      reason: settled.reason,
      notifyCheck: settled.notifyCheck,
    };
  } finally {
    clearInterval(poll);
    await db.releaseLease(input.owner);
  }
}

export async function recalibrateModeShared(
  db: SetpointDb,
  input: { mode: unknown },
): Promise<{ previous: SystemMode; systemMode: KnownMode; setpoint: number | null; version: number }> {
  if (!isKnownMode(input.mode)) {
    throw new RecalibrateError('Mode must be heat, off, or cool.', 'invalid');
  }
  const mode = input.mode;
  const acquired = await db.acquireLease(MODE_RECALIBRATE_OWNER, RECALIBRATE_LEASE_SECONDS);
  if (!acquired) {
    throw new RecalibrateError('A press is running. Wait for it to finish before recalibrating.', 'busy');
  }
  try {
    const state = await db.readState();
    const saved = await patchRetry(db, { systemMode: mode });
    return { previous: state.systemMode, systemMode: mode, setpoint: saved.virtualSetpoint, version: saved.version };
  } finally {
    await db.releaseLease(MODE_RECALIBRATE_OWNER);
  }
}

export async function refreshBatteryCache(
  db: SetpointDb,
  input: { now?: Date; readBattery: (deviceId: string) => Promise<number | null>; force?: boolean },
): Promise<BatteryReading | null> {
  const now = input.now ?? new Date();
  const state = await db.readState();
  const current = stateFromCache(state.batteryCache, now.getTime());
  if (!shouldFetchBatteries(current, now.getTime(), input.force ?? false)) {
    return state.batteryCache;
  }
  const loading = reduceBatteryFetch(current, { type: 'start' });
  const previous = loading.status === 'loading' ? loading.previous : null;
  const reading: BatteryReading = {
    up: previous?.up ?? null,
    down: previous?.down ?? null,
    mode: previous?.mode ?? null,
    fetchedAt: now.toISOString(),
  };
  let attempted = 0;
  let failed = 0;
  for (const slot of ['up', 'down', 'mode'] as const) {
    const device = state.deviceMap[slot];
    if (!device) {
      reading[slot] = null;
      continue;
    }
    attempted += 1;
    try {
      reading[slot] = await input.readBattery(device.id);
    } catch {
      failed += 1;
      reading[slot] = previous?.[slot] ?? null;
    }
  }
  if (attempted > 0 && failed === attempted) {
    const failedAt = now.toISOString();
    const saved: BatteryReading = {
      up: previous?.up ?? null,
      down: previous?.down ?? null,
      mode: previous?.mode ?? null,
      fetchedAt: previous?.fetchedAt ?? failedAt,
      failedAt,
    };
    await db.saveBatteryCache(saved);
    return previous;
  }
  await db.saveBatteryCache(reading);
  return reading;
}
