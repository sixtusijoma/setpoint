import type { Direction } from '../domain/planSetTo';
import { planSetTo } from '../domain/planSetTo';
import {
  runPressSession,
  sessionProgress,
  shouldStartHold,
  type CommandSource,
  type PressSession,
} from '../domain/pressSession';
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
    if (initial.virtualSetpoint === null) {
      return {
        status: 'refused',
        stoppedAt: input.target,
        wanted: input.target,
        reason: 'Set the virtual setpoint first.',
        notifyCheck: false,
      };
    }
    if (initial.mode !== 'live') {
      return {
        status: 'refused',
        stoppedAt: initial.virtualSetpoint,
        wanted: input.target,
        reason: 'The shared server only presses in live mode.',
        notifyCheck: false,
      };
    }
    const plan = planSetTo({
      current: initial.virtualSetpoint,
      target: input.target,
      step: initial.settings.step,
      minF: initial.settings.minF,
      maxF: initial.settings.maxF,
      pressCap: initial.settings.pressCap,
      wakeFirst: initial.settings.wakeFirst,
    });
    const settled = await runPressSession({
      current: initial.virtualSetpoint,
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
          void db.writeProgress(input.owner, progress);
        }
      },
      onCommitted: async (action, setpoint) => {
        if (action.kind !== 'adjust') {
          return;
        }
        const mark = changeLabel(input.source, setpoint);
        await patchRetry(db, { virtualSetpoint: setpoint });
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
  if (state.mode !== 'live' || state.virtualSetpoint === null) {
    return { apply: null, note: null };
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
    setpoint: state.virtualSetpoint,
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

export function deviceIds(map: ServerDeviceMap): { upId: string | null; downId: string | null } {
  return { upId: map.up?.id ?? null, downId: map.down?.id ?? null };
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
