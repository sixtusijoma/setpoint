import type { Direction, PressAction, SetPlan } from './planSetTo';

export type Mode = 'demo' | 'live';

export type CommandSource =
  | { kind: 'manual' }
  | { kind: 'set-to' }
  | { kind: 'preset'; label: string }
  | { kind: 'schedule' }
  | { kind: 'resume' }
  | { kind: 'apply-now' }
  | { kind: 'retry' }
  | { kind: 'run-now'; eventId: string; label: string; occurrenceKey: string };

export const PRESS_SPACING_MS: Readonly<Record<Direction, number>> = { down: 5000, up: 6000 };

export function pressGapMs(direction: Direction, delayMs: number): number {
  return Math.max(delayMs, PRESS_SPACING_MS[direction]);
}

export type SessionStatus = 'done' | 'cancelled' | 'failed' | 'ambiguous' | 'already' | 'refused' | 'busy';

export type RunningSession = {
  phase: 'armed' | 'in-flight' | 'waiting';
  target: number;
  startedFrom: number;
  setpoint: number;
  actionIndex: number;
  actions: PressAction[];
  source: CommandSource;
  mode: Mode;
  committedAdjusts: number;
  cancelRequested: boolean;
};

export type SettledSession = {
  phase: 'settled';
  status: SessionStatus;
  stoppedAt: number;
  wanted: number;
  reason?: string;
  committedAdjusts: number;
  notifyCheck: boolean;
  source: CommandSource;
};

export type PressSession = { phase: 'idle' } | RunningSession | SettledSession;

export type SessionEvent =
  | {
      type: 'start';
      target: number;
      startedFrom: number;
      actions: PressAction[];
      source: CommandSource;
      mode: Mode;
    }
  | { type: 'refuse'; reason: string; stoppedAt: number; wanted: number; source: CommandSource }
  | { type: 'already'; setpoint: number; target: number; source: CommandSource }
  | { type: 'busy'; stoppedAt: number; wanted: number; source: CommandSource }
  | { type: 'cancel' }
  | { type: 'begin-send' }
  | { type: 'success' }
  | { type: 'rejected'; reason: string }
  | { type: 'ambiguous'; reason: string }
  | { type: 'wait-elapsed' }
  | { type: 'out-of-time' }
  | { type: 'interrupt' };

export function idleSession(): PressSession {
  return { phase: 'idle' };
}

export function isRunning(session: PressSession): session is RunningSession {
  return session.phase === 'armed' || session.phase === 'in-flight' || session.phase === 'waiting';
}

function settle(input: Omit<SettledSession, 'phase'>): SettledSession {
  return { phase: 'settled', ...input };
}

export function reduceSession(session: PressSession, event: SessionEvent): PressSession {
  if (event.type === 'busy' || event.type === 'refuse' || event.type === 'already' || event.type === 'start') {
    if (session.phase !== 'idle') {
      return session;
    }
    if (event.type === 'busy') {
      return settle({
        status: 'busy',
        stoppedAt: event.stoppedAt,
        wanted: event.wanted,
        reason: 'A command is already running.',
        committedAdjusts: 0,
        notifyCheck: false,
        source: event.source,
      });
    }
    if (event.type === 'refuse') {
      return settle({
        status: 'refused',
        stoppedAt: event.stoppedAt,
        wanted: event.wanted,
        reason: event.reason,
        committedAdjusts: 0,
        notifyCheck: false,
        source: event.source,
      });
    }
    if (event.type === 'already') {
      return settle({
        status: 'already',
        stoppedAt: event.setpoint,
        wanted: event.target,
        committedAdjusts: 0,
        notifyCheck: false,
        source: event.source,
      });
    }
    if (event.actions.length === 0) {
      return settle({
        status: 'already',
        stoppedAt: event.startedFrom,
        wanted: event.target,
        committedAdjusts: 0,
        notifyCheck: false,
        source: event.source,
      });
    }
    return {
      phase: 'armed',
      target: event.target,
      startedFrom: event.startedFrom,
      setpoint: event.startedFrom,
      actionIndex: 0,
      actions: event.actions,
      source: event.source,
      mode: event.mode,
      committedAdjusts: 0,
      cancelRequested: false,
    };
  }

  if (!isRunning(session)) {
    return session;
  }

  if (event.type === 'cancel') {
    if (session.phase === 'in-flight') {
      if (session.cancelRequested) {
        return session;
      }
      return { ...session, cancelRequested: true };
    }
    return settle({
      status: 'cancelled',
      stoppedAt: session.setpoint,
      wanted: session.target,
      reason: 'Cancelled before the next press was sent.',
      committedAdjusts: session.committedAdjusts,
      notifyCheck: false,
      source: session.source,
    });
  }

  if (event.type === 'interrupt') {
    if (session.phase === 'in-flight') {
      return settle({
        status: 'ambiguous',
        stoppedAt: session.setpoint,
        wanted: session.target,
        reason: 'The app went to the background while a press was in flight.',
        committedAdjusts: session.committedAdjusts,
        notifyCheck: true,
        source: session.source,
      });
    }
    return settle({
      status: 'cancelled',
      stoppedAt: session.setpoint,
      wanted: session.target,
      reason: 'Stopped because the app was in the background.',
      committedAdjusts: session.committedAdjusts,
      notifyCheck: false,
      source: session.source,
    });
  }

  if (event.type === 'begin-send') {
    if (session.phase === 'in-flight') {
      return session;
    }
    if (session.cancelRequested) {
      return settle({
        status: 'cancelled',
        stoppedAt: session.setpoint,
        wanted: session.target,
        reason: 'Cancelled before the next press was sent.',
        committedAdjusts: session.committedAdjusts,
        notifyCheck: false,
        source: session.source,
      });
    }
    return { ...session, phase: 'in-flight', cancelRequested: false };
  }

  if (event.type === 'success') {
    if (session.phase !== 'in-flight') {
      return session;
    }
    const action = session.actions[session.actionIndex];
    if (!action) {
      return session;
    }
    let setpoint = session.setpoint;
    let committedAdjusts = session.committedAdjusts;
    if (action.kind === 'adjust' && action.setpointAfter !== null) {
      setpoint = action.setpointAfter;
      committedAdjusts += 1;
    }
    if (session.cancelRequested) {
      return settle({
        status: 'cancelled',
        stoppedAt: setpoint,
        wanted: session.target,
        reason: 'The press already in flight finished. Later presses were not sent.',
        committedAdjusts,
        notifyCheck: false,
        source: session.source,
      });
    }
    const nextIndex = session.actionIndex + 1;
    if (nextIndex >= session.actions.length) {
      return settle({
        status: 'done',
        stoppedAt: setpoint,
        wanted: session.target,
        committedAdjusts,
        notifyCheck: false,
        source: session.source,
      });
    }
    return {
      ...session,
      phase: 'waiting',
      setpoint,
      committedAdjusts,
      actionIndex: nextIndex,
      cancelRequested: false,
    };
  }

  if (event.type === 'rejected') {
    if (session.phase !== 'in-flight') {
      return session;
    }
    return settle({
      status: 'failed',
      stoppedAt: session.setpoint,
      wanted: session.target,
      reason: event.reason,
      committedAdjusts: session.committedAdjusts,
      notifyCheck: false,
      source: session.source,
    });
  }

  if (event.type === 'ambiguous') {
    if (session.phase !== 'in-flight') {
      return session;
    }
    return settle({
      status: 'ambiguous',
      stoppedAt: session.setpoint,
      wanted: session.target,
      reason: event.reason,
      committedAdjusts: session.committedAdjusts,
      notifyCheck: true,
      source: session.source,
    });
  }

  if (event.type === 'out-of-time') {
    if (session.phase === 'in-flight') {
      return session;
    }
    return settle({
      status: 'failed',
      stoppedAt: session.setpoint,
      wanted: session.target,
      reason: `Out of server time after ${session.actionIndex} of ${session.actions.length} presses. The rest were not sent. Send it again to finish.`,
      committedAdjusts: session.committedAdjusts,
      notifyCheck: false,
      source: session.source,
    });
  }

  if (event.type === 'wait-elapsed') {
    if (session.phase !== 'waiting') {
      return session;
    }
    if (session.cancelRequested) {
      return settle({
        status: 'cancelled',
        stoppedAt: session.setpoint,
        wanted: session.target,
        reason: 'Cancelled before the next press was sent.',
        committedAdjusts: session.committedAdjusts,
        notifyCheck: false,
        source: session.source,
      });
    }
    return { ...session, phase: 'armed' };
  }

  return session;
}

export function sessionProgress(session: PressSession): {
  index: number;
  total: number;
  target: number;
  label: 'press' | 'finishing';
} | null {
  if (!isRunning(session)) {
    return null;
  }
  return {
    index: session.actionIndex + 1,
    total: session.actions.length,
    target: session.target,
    label: session.phase === 'in-flight' && session.cancelRequested ? 'finishing' : 'press',
  };
}

export function shouldStartHold(source: CommandSource, settled: SettledSession): boolean {
  if (source.kind !== 'manual' && source.kind !== 'set-to' && source.kind !== 'preset') {
    return false;
  }
  if (settled.committedAdjusts < 1) {
    return false;
  }
  if (settled.status !== 'done' && settled.status !== 'cancelled') {
    return false;
  }
  return true;
}

export class PressOutcomeError extends Error {
  readonly kind: 'ambiguous' | 'rejected';

  constructor(message: string, kind: 'ambiguous' | 'rejected') {
    super(message);
    this.name = 'PressOutcomeError';
    this.kind = kind;
  }
}

export function classifyPressError(error: unknown): { kind: 'ambiguous' | 'rejected'; message: string } {
  if (error instanceof PressOutcomeError) {
    return { kind: error.kind, message: error.message };
  }
  if (error && typeof error === 'object' && 'kind' in error) {
    const kind = (error as { kind?: unknown }).kind;
    if (kind === 'ambiguous' || kind === 'rejected') {
      const message = error instanceof Error ? error.message : 'The press failed.';
      return { kind, message };
    }
  }
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
    return { kind: 'ambiguous', message: 'The press timed out. The thermostat may have moved.' };
  }
  if (error instanceof Error && error.message) {
    return { kind: 'rejected', message: error.message };
  }
  return { kind: 'rejected', message: 'The press failed.' };
}

export type RunPressInput = {
  current: number;
  target: number;
  source: CommandSource;
  mode: Mode;
  plan: SetPlan;
  delayMs: number;
  timeLimit?: { endsAt: number; perPressMs: number; now: () => number };
  press: (direction: Direction, signal: AbortSignal) => Promise<void>;
  sleep: (ms: number, isCancelled: () => boolean) => Promise<boolean>;
  beforeSend: (index: number, isCancelled: () => boolean) => Promise<boolean>;
  isCancelled: () => boolean;
  isInterrupted: () => boolean;
  onSession: (session: PressSession) => void;
  onCommitted?: (action: PressAction, setpoint: number) => void | Promise<void>;
};

function asSettled(session: PressSession): SettledSession {
  if (session.phase === 'settled') {
    return session;
  }
  return settle({
    status: 'failed',
    stoppedAt: session.phase === 'idle' ? 0 : session.setpoint,
    wanted: session.phase === 'idle' ? 0 : session.target,
    reason: 'The press session ended in an unexpected phase.',
    committedAdjusts: session.phase === 'idle' ? 0 : session.committedAdjusts,
    notifyCheck: false,
    source: session.phase === 'idle' ? { kind: 'manual' } : session.source,
  });
}

export async function runPressSession(input: RunPressInput): Promise<SettledSession> {
  const publish = (session: PressSession): SettledSession | null => {
    input.onSession(session);
    if (session.phase === 'settled') {
      return session;
    }
    return null;
  };

  if (!input.plan.ok) {
    const refused = reduceSession(idleSession(), {
      type: 'refuse',
      reason: input.plan.reason,
      stoppedAt: input.current,
      wanted: input.target,
      source: input.source,
    });
    return asSettled(publish(refused) ?? refused);
  }

  let session = reduceSession(idleSession(), {
    type: 'start',
    target: input.target,
    startedFrom: input.current,
    actions: input.plan.actions,
    source: input.source,
    mode: input.mode,
  });
  const started = publish(session);
  if (started) {
    return started;
  }

  while (isRunning(session)) {
    if (session.phase === 'waiting') {
      const next = session.actions[session.actionIndex];
      const gap = next ? pressGapMs(next.direction, input.delayMs) : input.delayMs;
      const limit = input.timeLimit;
      if (limit && limit.now() + gap + limit.perPressMs > limit.endsAt) {
        session = reduceSession(session, { type: 'out-of-time' });
        return asSettled(publish(session) ?? session);
      }
      const aborted = await input.sleep(gap, () => input.isCancelled() || input.isInterrupted());
      if (input.isInterrupted() && !input.isCancelled()) {
        session = reduceSession(session, { type: 'interrupt' });
        return asSettled(publish(session) ?? session);
      }
      if (aborted || input.isCancelled()) {
        session = reduceSession(session, { type: 'cancel' });
        return asSettled(publish(session) ?? session);
      }
      session = reduceSession(session, { type: 'wait-elapsed' });
      const waited = publish(session);
      if (waited) {
        return waited;
      }
      continue;
    }

    if (session.phase === 'armed') {
      const index = session.actionIndex;
      const aborted = await input.beforeSend(index, () => input.isCancelled() || input.isInterrupted());
      if (input.isInterrupted() && !input.isCancelled()) {
        session = reduceSession(session, { type: 'interrupt' });
        return asSettled(publish(session) ?? session);
      }
      if (aborted || input.isCancelled()) {
        session = reduceSession(session, { type: 'cancel' });
        return asSettled(publish(session) ?? session);
      }
      session = reduceSession(session, { type: 'begin-send' });
      const began = publish(session);
      if (began) {
        return began;
      }
      continue;
    }

    const action = session.actions[session.actionIndex];
    if (!action) {
      session = reduceSession(session, { type: 'rejected', reason: 'The press plan ran out of actions.' });
      return asSettled(publish(session) ?? session);
    }
    const controller = new AbortController();
    const watch = setInterval(() => {
      if (input.isInterrupted()) {
        controller.abort();
        return;
      }
      if (input.isCancelled() && isRunning(session) && !session.cancelRequested) {
        session = reduceSession(session, { type: 'cancel' });
        input.onSession(session);
      }
    }, 30);
    let failed: unknown = null;
    try {
      await input.press(action.direction, controller.signal);
    } catch (error) {
      failed = error;
    } finally {
      clearInterval(watch);
    }
    if (failed) {
      if (input.isInterrupted()) {
        session = reduceSession(session, { type: 'interrupt' });
      } else {
        const classified = classifyPressError(failed);
        session = reduceSession(
          session,
          classified.kind === 'ambiguous'
            ? { type: 'ambiguous', reason: classified.message }
            : { type: 'rejected', reason: classified.message },
        );
      }
      return asSettled(publish(session) ?? session);
    }
    const before = session;
    session = reduceSession(session, { type: 'success' });
    const committedSetpoint =
      session.phase === 'settled' ? session.stoppedAt : session.phase === 'idle' ? before.setpoint : session.setpoint;
    if (before.phase === 'in-flight') {
      await input.onCommitted?.(action, committedSetpoint);
    }
    const done = publish(session);
    if (done) {
      return done;
    }
  }

  return asSettled(session);
}
