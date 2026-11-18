import { classifyPressError } from './pressSession';
import { advanceMode, pressesToMode, type KnownMode, type ModeStep, type SystemMode } from './systemMode';
import { UNKNOWN_MODE_REASON } from './modeSetpoint';

export const MODE_PRESS_SPACING_MS = 6000;

export function modePressGapMs(delayMs: number): number {
  return Math.max(delayMs, MODE_PRESS_SPACING_MS);
}

export type ModeSource = { kind: 'set-mode' } | { kind: 'mcp' };

export type ModeStatus = 'done' | 'cancelled' | 'failed' | 'ambiguous' | 'already' | 'refused' | 'busy';

export type RunningModeSession = {
  phase: 'armed' | 'in-flight' | 'waiting';
  target: KnownMode;
  startedFrom: KnownMode;
  tracked: KnownMode;
  step: ModeStep;
  index: number;
  total: number;
  committed: number;
  cancelRequested: boolean;
  source: ModeSource;
};

export type SettledModeSession = {
  phase: 'settled';
  status: ModeStatus;
  tracked: SystemMode;
  wanted: KnownMode;
  reason?: string;
  committed: number;
  notifyCheck: boolean;
  source: ModeSource;
};

export type ModeSession = { phase: 'idle' } | RunningModeSession | SettledModeSession;

export type ModeSessionEvent =
  | { type: 'start'; from: KnownMode; target: KnownMode; step: ModeStep; source: ModeSource }
  | { type: 'refuse'; reason: string; wanted: KnownMode; tracked: SystemMode; source: ModeSource }
  | { type: 'already'; mode: KnownMode; source: ModeSource }
  | { type: 'busy'; wanted: KnownMode; tracked: SystemMode; source: ModeSource }
  | { type: 'cancel' }
  | { type: 'begin-send' }
  | { type: 'success' }
  | { type: 'rejected'; reason: string }
  | { type: 'ambiguous'; reason: string }
  | { type: 'wait-elapsed' }
  | { type: 'out-of-time' }
  | { type: 'interrupt' };

export function idleModeSession(): ModeSession {
  return { phase: 'idle' };
}

export function isModeRunning(session: ModeSession): session is RunningModeSession {
  return session.phase === 'armed' || session.phase === 'in-flight' || session.phase === 'waiting';
}

function settle(input: Omit<SettledModeSession, 'phase'>): SettledModeSession {
  return { phase: 'settled', ...input };
}

export function reduceModeSession(session: ModeSession, event: ModeSessionEvent): ModeSession {
  if (event.type === 'busy' || event.type === 'refuse' || event.type === 'already' || event.type === 'start') {
    if (session.phase !== 'idle') {
      return session;
    }
    if (event.type === 'busy') {
      return settle({
        status: 'busy',
        tracked: event.tracked,
        wanted: event.wanted,
        reason: 'A command is already running.',
        committed: 0,
        notifyCheck: false,
        source: event.source,
      });
    }
    if (event.type === 'refuse') {
      return settle({
        status: 'refused',
        tracked: event.tracked,
        wanted: event.wanted,
        reason: event.reason,
        committed: 0,
        notifyCheck: false,
        source: event.source,
      });
    }
    if (event.type === 'already') {
      return settle({
        status: 'already',
        tracked: event.mode,
        wanted: event.mode,
        committed: 0,
        notifyCheck: false,
        source: event.source,
      });
    }
    const total = pressesToMode(event.from, event.target, event.step);
    if (total === 0) {
      return settle({
        status: 'already',
        tracked: event.from,
        wanted: event.target,
        committed: 0,
        notifyCheck: false,
        source: event.source,
      });
    }
    return {
      phase: 'armed',
      target: event.target,
      startedFrom: event.from,
      tracked: event.from,
      step: event.step,
      index: 0,
      total,
      committed: 0,
      cancelRequested: false,
      source: event.source,
    };
  }

  if (!isModeRunning(session)) {
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
      tracked: session.tracked,
      wanted: session.target,
      reason: 'Cancelled before the next press was sent.',
      committed: session.committed,
      notifyCheck: false,
      source: session.source,
    });
  }

  if (event.type === 'interrupt') {
    if (session.phase === 'in-flight') {
      return settle({
        status: 'ambiguous',
        tracked: session.tracked,
        wanted: session.target,
        reason: 'The app went to the background while a press was in flight.',
        committed: session.committed,
        notifyCheck: true,
        source: session.source,
      });
    }
    return settle({
      status: 'cancelled',
      tracked: session.tracked,
      wanted: session.target,
      reason: 'Stopped because the app was in the background.',
      committed: session.committed,
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
        tracked: session.tracked,
        wanted: session.target,
        reason: 'Cancelled before the next press was sent.',
        committed: session.committed,
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
    const moved = advanceMode(session.tracked, session.step);
    const committed = session.committed + 1;
    if (session.cancelRequested) {
      return settle({
        status: 'cancelled',
        tracked: moved,
        wanted: session.target,
        reason: 'The press already in flight finished. Later presses were not sent.',
        committed,
        notifyCheck: false,
        source: session.source,
      });
    }
    const nextIndex = session.index + 1;
    if (nextIndex >= session.total) {
      return settle({
        status: 'done',
        tracked: moved,
        wanted: session.target,
        committed,
        notifyCheck: false,
        source: session.source,
      });
    }
    return {
      ...session,
      phase: 'waiting',
      tracked: moved,
      committed,
      index: nextIndex,
      cancelRequested: false,
    };
  }

  if (event.type === 'rejected') {
    if (session.phase !== 'in-flight') {
      return session;
    }
    return settle({
      status: 'failed',
      tracked: session.tracked,
      wanted: session.target,
      reason: event.reason,
      committed: session.committed,
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
      tracked: session.tracked,
      wanted: session.target,
      reason: event.reason,
      committed: session.committed,
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
      tracked: session.tracked,
      wanted: session.target,
      reason: `Out of server time after ${session.index} of ${session.total} presses. The rest were not sent. Send it again to finish.`,
      committed: session.committed,
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
        tracked: session.tracked,
        wanted: session.target,
        reason: 'Cancelled before the next press was sent.',
        committed: session.committed,
        notifyCheck: false,
        source: session.source,
      });
    }
    return { ...session, phase: 'armed' };
  }

  return session;
}

export function modeProgress(session: ModeSession): {
  index: number;
  total: number;
  target: KnownMode;
  label: 'press' | 'finishing';
} | null {
  if (!isModeRunning(session)) {
    return null;
  }
  return {
    index: session.index + 1,
    total: session.total,
    target: session.target,
    label: session.phase === 'in-flight' && session.cancelRequested ? 'finishing' : 'press',
  };
}

export function beginModeSession(input: {
  from: KnownMode;
  target: KnownMode;
  step: ModeStep;
  source: ModeSource;
}): { session: RunningModeSession; progress: NonNullable<ReturnType<typeof modeProgress>> } | null {
  const session = reduceModeSession(idleModeSession(), { type: 'start', ...input });
  if (!isModeRunning(session)) {
    return null;
  }
  const progress = modeProgress(session);
  if (!progress) {
    return null;
  }
  return { session, progress };
}

export function planModePresses(
  from: SystemMode,
  target: KnownMode,
  step: ModeStep,
): { ok: true; presses: number } | { ok: false; reason: string } {
  if (from === 'unknown') {
    return { ok: false, reason: UNKNOWN_MODE_REASON };
  }
  return { ok: true, presses: pressesToMode(from, target, step) };
}

function asSettled(session: ModeSession, source: ModeSource, wanted: KnownMode): SettledModeSession {
  if (session.phase === 'settled') {
    return session;
  }
  return settle({
    status: 'failed',
    tracked: session.phase === 'idle' ? 'unknown' : session.tracked,
    wanted,
    reason: 'The mode press ended in an unexpected phase.',
    committed: session.phase === 'idle' ? 0 : session.committed,
    notifyCheck: false,
    source,
  });
}

export type RunModeInput = {
  from: SystemMode;
  target: KnownMode;
  step: ModeStep;
  source: ModeSource;
  delayMs: number;
  timeLimit?: { endsAt: number; perPressMs: number; now: () => number };
  press: (signal: AbortSignal) => Promise<void>;
  sleep: (ms: number, isCancelled: () => boolean) => Promise<boolean>;
  beforeSend: (index: number, isCancelled: () => boolean) => Promise<boolean>;
  isCancelled: () => boolean;
  isInterrupted: () => boolean;
  onSession: (session: ModeSession) => void;
  onCommitted?: (mode: KnownMode) => void | Promise<void>;
};

export async function runModeSession(input: RunModeInput): Promise<SettledModeSession> {
  const publish = (session: ModeSession): SettledModeSession | null => {
    input.onSession(session);
    if (session.phase === 'settled') {
      return session;
    }
    return null;
  };

  if (input.from === 'unknown') {
    const refused = reduceModeSession(idleModeSession(), {
      type: 'refuse',
      reason: UNKNOWN_MODE_REASON,
      wanted: input.target,
      tracked: 'unknown',
      source: input.source,
    });
    return asSettled(publish(refused) ?? refused, input.source, input.target);
  }
  let session = reduceModeSession(idleModeSession(), {
    type: 'start',
    from: input.from,
    target: input.target,
    step: input.step,
    source: input.source,
  });
  const started = publish(session);
  if (started) {
    return started;
  }

  while (isModeRunning(session)) {
    if (session.phase === 'waiting') {
      const gap = modePressGapMs(input.delayMs);
      const limit = input.timeLimit;
      if (limit && limit.now() + gap + limit.perPressMs > limit.endsAt) {
        session = reduceModeSession(session, { type: 'out-of-time' });
        return asSettled(publish(session) ?? session, input.source, input.target);
      }
      const aborted = await input.sleep(gap, () => input.isCancelled() || input.isInterrupted());
      if (input.isInterrupted() && !input.isCancelled()) {
        session = reduceModeSession(session, { type: 'interrupt' });
        return asSettled(publish(session) ?? session, input.source, input.target);
      }
      if (aborted || input.isCancelled()) {
        session = reduceModeSession(session, { type: 'cancel' });
        return asSettled(publish(session) ?? session, input.source, input.target);
      }
      session = reduceModeSession(session, { type: 'wait-elapsed' });
      const waited = publish(session);
      if (waited) {
        return waited;
      }
      continue;
    }

    if (session.phase === 'armed') {
      const index = session.index;
      const aborted = await input.beforeSend(index, () => input.isCancelled() || input.isInterrupted());
      if (input.isInterrupted() && !input.isCancelled()) {
        session = reduceModeSession(session, { type: 'interrupt' });
        return asSettled(publish(session) ?? session, input.source, input.target);
      }
      if (aborted || input.isCancelled()) {
        session = reduceModeSession(session, { type: 'cancel' });
        return asSettled(publish(session) ?? session, input.source, input.target);
      }
      session = reduceModeSession(session, { type: 'begin-send' });
      const began = publish(session);
      if (began) {
        return began;
      }
      continue;
    }

    const controller = new AbortController();
    const watch = setInterval(() => {
      if (input.isInterrupted()) {
        controller.abort();
        return;
      }
      if (input.isCancelled() && isModeRunning(session) && !session.cancelRequested) {
        session = reduceModeSession(session, { type: 'cancel' });
        input.onSession(session);
      }
    }, 30);
    let failed: unknown = null;
    try {
      await input.press(controller.signal);
    } catch (error) {
      failed = error;
    } finally {
      clearInterval(watch);
    }
    if (failed) {
      if (input.isInterrupted()) {
        session = reduceModeSession(session, { type: 'interrupt' });
      } else {
        const classified = classifyPressError(failed);
        session = reduceModeSession(
          session,
          classified.kind === 'ambiguous'
            ? { type: 'ambiguous', reason: classified.message }
            : { type: 'rejected', reason: classified.message },
        );
      }
      return asSettled(publish(session) ?? session, input.source, input.target);
    }
    const before = session;
    session = reduceModeSession(session, { type: 'success' });
    if (before.phase === 'in-flight' && (session.phase === 'settled' || session.phase === 'waiting') && session.tracked !== 'unknown') {
      await input.onCommitted?.(session.tracked);
    }
    const done = publish(session);
    if (done) {
      return done;
    }
  }

  return asSettled(session, input.source, input.target);
}
