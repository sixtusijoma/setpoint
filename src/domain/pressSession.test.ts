import { afterEach, describe, expect, it, vi } from 'vitest';

import { executePlan, sleepUnlessCancelled } from '@/domain/execute';
import { planSetTo, type PressAction } from '@/domain/planSetTo';
import {
  classifyPressError,
  idleSession,
  PressOutcomeError,
  PRESS_SPACING_MS,
  pressGapMs,
  reduceSession,
  runPressSession,
  sessionProgress,
  shouldStartHold,
  type PressSession,
  type RunningSession,
  type SessionEvent,
} from '@/domain/pressSession';

const source = { kind: 'manual' as const };
const actions: PressAction[] = [
  { kind: 'adjust', direction: 'up', setpointAfter: 71 },
  { kind: 'adjust', direction: 'up', setpointAfter: 72 },
  { kind: 'adjust', direction: 'up', setpointAfter: 73 },
];

function armed(): RunningSession {
  const session = reduceSession(idleSession(), {
    type: 'start',
    target: 73,
    startedFrom: 70,
    actions,
    source,
    mode: 'demo',
  });
  if (session.phase !== 'armed') {
    throw new Error('expected armed');
  }
  return session;
}

describe('press session reducer', () => {
  it('takes the lock before any press', () => {
    const session = armed();
    expect(session.phase).toBe('armed');
    expect(session.setpoint).toBe(70);
    expect(session.committedAdjusts).toBe(0);
    expect(sessionProgress(session)?.label).toBe('press');
  });

  it('cancels an armed press before it is sent, including the first one', () => {
    const session = reduceSession(armed(), { type: 'cancel' });
    expect(session.phase).toBe('settled');
    if (session.phase !== 'settled') {
      return;
    }
    expect(session.status).toBe('cancelled');
    expect(session.stoppedAt).toBe(70);
    expect(session.committedAdjusts).toBe(0);
    expect(shouldStartHold(source, session)).toBe(false);
  });

  it('lets an in-flight press finish and then stops', () => {
    const inflight = reduceSession(armed(), { type: 'begin-send' });
    const finishing = reduceSession(inflight, { type: 'cancel' });
    expect(finishing.phase).toBe('in-flight');
    expect(sessionProgress(finishing)?.label).toBe('finishing');
    const settled = reduceSession(finishing, { type: 'success' });
    expect(settled.phase).toBe('settled');
    if (settled.phase !== 'settled') {
      return;
    }
    expect(settled.status).toBe('cancelled');
    expect(settled.stoppedAt).toBe(71);
    expect(settled.committedAdjusts).toBe(1);
    expect(shouldStartHold(source, settled)).toBe(true);
  });

  it('does not count an ambiguous press and asks for a check', () => {
    const inflight = reduceSession(armed(), { type: 'begin-send' });
    const settled = reduceSession(inflight, { type: 'ambiguous', reason: 'The response was lost.' });
    expect(settled.phase).toBe('settled');
    if (settled.phase !== 'settled') {
      return;
    }
    expect(settled.status).toBe('ambiguous');
    expect(settled.stoppedAt).toBe(70);
    expect(settled.notifyCheck).toBe(true);
    expect(settled.committedAdjusts).toBe(0);
    expect(shouldStartHold(source, settled)).toBe(false);
  });

  it('does not count a rejected press', () => {
    const inflight = reduceSession(armed(), { type: 'begin-send' });
    const settled = reduceSession(inflight, { type: 'rejected', reason: 'device offline' });
    expect(settled.phase).toBe('settled');
    if (settled.phase !== 'settled') {
      return;
    }
    expect(settled.status).toBe('failed');
    expect(settled.stoppedAt).toBe(70);
    expect(settled.notifyCheck).toBe(false);
    expect(shouldStartHold(source, settled)).toBe(false);
  });

  it('commits each adjust and finishes on the last press', () => {
    let session: PressSession = armed();
    session = reduceSession(session, { type: 'begin-send' });
    session = reduceSession(session, { type: 'success' });
    expect(session.phase).toBe('waiting');
    session = reduceSession(session, { type: 'wait-elapsed' });
    session = reduceSession(session, { type: 'begin-send' });
    session = reduceSession(session, { type: 'success' });
    session = reduceSession(session, { type: 'wait-elapsed' });
    session = reduceSession(session, { type: 'begin-send' });
    session = reduceSession(session, { type: 'success' });
    expect(session.phase).toBe('settled');
    if (session.phase !== 'settled') {
      return;
    }
    expect(session.status).toBe('done');
    expect(session.stoppedAt).toBe(73);
    expect(shouldStartHold(source, session)).toBe(true);
    expect(shouldStartHold({ kind: 'schedule' }, session)).toBe(false);
    expect(shouldStartHold({ kind: 'run-now', eventId: 'default-sleep', label: 'Sleep', occurrenceKey: 'k' }, session)).toBe(
      false,
    );
  });

  it('does not start a hold for a zero-press result', () => {
    const session = reduceSession(idleSession(), {
      type: 'already',
      setpoint: 72,
      target: 72,
      source: { kind: 'preset', label: 'Home' },
    });
    expect(session.phase).toBe('settled');
    if (session.phase !== 'settled') {
      return;
    }
    expect(shouldStartHold({ kind: 'preset', label: 'Home' }, session)).toBe(false);
  });

  it('ignores illegal events instead of inventing a phase', () => {
    const idle = idleSession();
    const illegal: SessionEvent[] = [
      { type: 'success' },
      { type: 'cancel' },
      { type: 'begin-send' },
      { type: 'rejected', reason: 'no' },
      { type: 'ambiguous', reason: 'no' },
      { type: 'wait-elapsed' },
      { type: 'interrupt' },
    ];
    for (const event of illegal) {
      expect(reduceSession(idle, event)).toEqual(idle);
    }
    const running = armed();
    expect(reduceSession(running, { type: 'start', target: 80, startedFrom: 70, actions, source, mode: 'live' })).toEqual(
      running,
    );
    expect(reduceSession(running, { type: 'success' })).toEqual(running);
    const settled = reduceSession(running, { type: 'cancel' });
    expect(reduceSession(settled, { type: 'success' })).toEqual(settled);
    expect(reduceSession(settled, { type: 'cancel' })).toEqual(settled);
  });

  it('treats a background interrupt during the request as ambiguous', () => {
    const inflight = reduceSession(armed(), { type: 'begin-send' });
    const settled = reduceSession(inflight, { type: 'interrupt' });
    expect(settled.phase).toBe('settled');
    if (settled.phase !== 'settled') {
      return;
    }
    expect(settled.status).toBe('ambiguous');
    expect(settled.notifyCheck).toBe(true);
    expect(settled.stoppedAt).toBe(70);
  });

  it('cancels a background interrupt before the request is sent', () => {
    const settled = reduceSession(armed(), { type: 'interrupt' });
    expect(settled.phase).toBe('settled');
    if (settled.phase !== 'settled') {
      return;
    }
    expect(settled.status).toBe('cancelled');
    expect(settled.notifyCheck).toBe(false);
  });
});

describe('runPressSession', () => {
  it('does not send the first press when cancel is already set', async () => {
    const plan = planSetTo({
      current: 70,
      target: 72,
      step: 1,
      minF: 50,
      maxF: 85,
      pressCap: 15,
      wakeFirst: false,
    });
    const sent: string[] = [];
    const settled = await runPressSession({
      current: 70,
      target: 72,
      source,
      mode: 'demo',
      plan,
      delayMs: 0,
      press: async (direction) => {
        sent.push(direction);
      },
      sleep: async () => false,
      beforeSend: async () => true,
      isCancelled: () => true,
      isInterrupted: () => false,
      onSession: () => undefined,
    });
    expect(sent).toEqual([]);
    expect(settled.status).toBe('cancelled');
    expect(settled.stoppedAt).toBe(70);
  });

  it('counts an in-flight success after cancel and skips the rest', async () => {
    const plan = planSetTo({
      current: 70,
      target: 73,
      step: 1,
      minF: 50,
      maxF: 85,
      pressCap: 15,
      wakeFirst: false,
    });
    let cancel = false;
    const settled = await runPressSession({
      current: 70,
      target: 73,
      source,
      mode: 'demo',
      plan,
      delayMs: 0,
      press: async () => {
        cancel = true;
      },
      sleep: async (_ms, isCancelled) => isCancelled(),
      beforeSend: async () => false,
      isCancelled: () => cancel,
      isInterrupted: () => false,
      onSession: () => undefined,
    });
    expect(settled.status).toBe('cancelled');
    expect(settled.stoppedAt).toBe(71);
    expect(settled.committedAdjusts).toBe(1);
  });

  it('stops on an ambiguous error without counting it', async () => {
    const plan = planSetTo({
      current: 70,
      target: 72,
      step: 1,
      minF: 50,
      maxF: 85,
      pressCap: 15,
      wakeFirst: false,
    });
    const settled = await runPressSession({
      current: 70,
      target: 72,
      source: { kind: 'schedule' },
      mode: 'live',
      plan,
      delayMs: 0,
      press: async () => {
        throw new PressOutcomeError('The response was lost.', 'ambiguous');
      },
      sleep: async () => false,
      beforeSend: async () => false,
      isCancelled: () => false,
      isInterrupted: () => false,
      onSession: () => undefined,
    });
    expect(settled.status).toBe('ambiguous');
    expect(settled.stoppedAt).toBe(70);
    expect(settled.notifyCheck).toBe(true);
    expect(shouldStartHold({ kind: 'schedule' }, settled)).toBe(false);
  });
});

describe('classifyPressError', () => {
  it('keeps a timeout ambiguous and a thrown message rejected', () => {
    const timeout = new Error('timed out');
    timeout.name = 'TimeoutError';
    expect(classifyPressError(timeout).kind).toBe('ambiguous');
    expect(classifyPressError(new Error('device offline')).kind).toBe('rejected');
  });
});

describe('press spacing', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function timedRun(current: number, target: number, cancelAfterPress?: number) {
    const plan = planSetTo({ current, target, step: 1, minF: 50, maxF: 85, pressCap: 15, wakeFirst: false });
    if (!plan.ok) {
      throw new Error(plan.reason);
    }
    const log: { direction: string; startedAt: number; returnedAt: number }[] = [];
    let cancelled = false;
    const run = executePlan(plan, current, {
      pressUp: async () => {
        const startedAt = Date.now();
        await new Promise((resolve) => setTimeout(resolve, 700));
        log.push({ direction: 'up', startedAt, returnedAt: Date.now() });
        if (log.length === cancelAfterPress) {
          cancelled = true;
        }
      },
      pressDown: async () => {
        const startedAt = Date.now();
        await new Promise((resolve) => setTimeout(resolve, 700));
        log.push({ direction: 'down', startedAt, returnedAt: Date.now() });
        if (log.length === cancelAfterPress) {
          cancelled = true;
        }
      },
      delayMs: 1000,
      sleep: sleepUnlessCancelled,
      isCancelled: () => cancelled,
      onProgress: () => undefined,
      onCommitted: () => undefined,
    });
    return { run, log };
  }

  function gapsOf(log: { startedAt: number; returnedAt: number }[]): number[] {
    return log.slice(1).map((entry, index) => entry.startedAt - (log[index]?.returnedAt ?? 0));
  }

  it('waits at least 5 seconds between down presses, measured from the last return', async () => {
    vi.useFakeTimers();
    const { run, log } = timedRun(70, 65);
    await vi.advanceTimersByTimeAsync(60_000);
    const result = await run;
    expect(result.status).toBe('done');
    expect(result.completedPresses).toBe(5);
    expect(log).toHaveLength(5);
    expect(gapsOf(log).every((gap) => gap >= PRESS_SPACING_MS.down)).toBe(true);
    expect(gapsOf(log).every((gap) => gap < PRESS_SPACING_MS.down + 100)).toBe(true);
  });

  it('waits at least 6 seconds between up presses', async () => {
    vi.useFakeTimers();
    const { run, log } = timedRun(70, 73);
    await vi.advanceTimersByTimeAsync(60_000);
    expect((await run).status).toBe('done');
    expect(gapsOf(log)).toHaveLength(2);
    expect(gapsOf(log).every((gap) => gap >= PRESS_SPACING_MS.up)).toBe(true);
  });

  it('cancels during the wait without sending the rest', async () => {
    vi.useFakeTimers();
    const { run, log } = timedRun(70, 65, 2);
    await vi.advanceTimersByTimeAsync(60_000);
    const result = await run;
    expect(result.status).toBe('cancelled');
    expect(result.completedPresses).toBe(2);
    expect(result.stoppedAt).toBe(68);
    expect(log).toHaveLength(2);
  });

  it('keeps a longer configured delay', () => {
    expect(pressGapMs('down', 1000)).toBe(5000);
    expect(pressGapMs('up', 1000)).toBe(6000);
    expect(pressGapMs('down', 8000)).toBe(8000);
  });
});

describe('press time limit', () => {
  it('stops before a press that could not finish in time and never reports it done', async () => {
    let clock = 0;
    const presses: string[] = [];
    const sessions: PressSession[] = [];
    const plan = planSetTo({ current: 70, target: 79, step: 1, minF: 50, maxF: 85, pressCap: 15, wakeFirst: false });
    const settled = await runPressSession({
      current: 70,
      target: 79,
      source,
      mode: 'live',
      plan,
      delayMs: 0,
      timeLimit: { endsAt: 30_000, perPressMs: 12_000, now: () => clock },
      press: async (direction) => {
        presses.push(direction);
        clock += 1000;
      },
      sleep: async (ms) => {
        clock += ms;
        return false;
      },
      beforeSend: async () => false,
      isCancelled: () => false,
      isInterrupted: () => false,
      onSession: (session) => sessions.push(session),
    });
    expect(presses).toEqual(['up', 'up', 'up']);
    expect(settled.status).toBe('failed');
    expect(settled.stoppedAt).toBe(73);
    expect(settled.committedAdjusts).toBe(3);
    expect(settled.reason).toContain('Out of server time after 3 of 9 presses');
    expect(sessions.some((session) => session.phase === 'settled' && session.status === 'done')).toBe(false);
  });

  it('ignores the time limit while a press is in flight', () => {
    const inflight = reduceSession(armed(), { type: 'begin-send' });
    expect(reduceSession(inflight, { type: 'out-of-time' })).toBe(inflight);
  });
});
