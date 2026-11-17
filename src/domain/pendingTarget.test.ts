import { describe, expect, it } from 'vitest';

import {
  BUMP_DEBOUNCE_MS,
  boundedTarget,
  commandContinuation,
  commandLocks,
  dropsDesiredOnBusy,
  idlePending,
  pendingInvariant,
  reducePendingTarget,
  schedulerBlocked,
  shownProgressTarget,
  stepSetpoint,
  type CapLimits,
  type PendingEvent,
  type PendingTarget,
  type StepLimits,
} from '@/domain/pendingTarget';

const limits: StepLimits = {
  step: 1,
  min: 50,
  max: 85,
  pressCap: 15,
  wakeFirst: false,
};

const cap: CapLimits = { step: 1, min: 50, max: 85, pressCap: 15 };

function bump(state: PendingTarget, direction: 1 | -1, setpoint = 70, over: Partial<StepLimits> = {}) {
  return reducePendingTarget(state, {
    type: 'bump',
    direction,
    setpoint,
    limits: { ...limits, ...over },
  });
}

function elapsed(state: PendingTarget, from = 70, over: Partial<CapLimits> = {}) {
  return reducePendingTarget(state, {
    type: 'debounce-elapsed',
    from,
    limits: { ...cap, ...over },
  });
}

describe('pending target', () => {
  it('stacks taps on desired instead of the stale setpoint', () => {
    let state = idlePending();
    state = bump(state, 1, 70).state;
    state = bump(state, 1, 70).state;
    const third = bump(state, 1, 70);
    expect(third.state).toEqual({ status: 'pending', desired: 73, anchor: 70, wake: false });
    expect(third.effect).toEqual({ type: 'arm-timer', ms: BUMP_DEBOUNCE_MS });
    const sent = elapsed(third.state, 70);
    expect(sent.effect).toEqual({ type: 'send', target: 73, wake: false });
    expect(sent.state).toEqual({ status: 'running', desired: 73, inflight: 73 });
    expect(pendingInvariant(sent.state)).toBe(true);
  });

  it('sends one chunk inside the press cap and follows up without a second wake', () => {
    let state = idlePending();
    for (let count = 0; count < 4; count += 1) {
      state = bump(state, 1, 70, { wakeFirst: true, pressCap: 3 }).state;
    }
    expect(state).toEqual({ status: 'pending', desired: 74, anchor: 70, wake: true });
    const first = elapsed(state, 70, { pressCap: 3 });
    expect(first.effect).toEqual({ type: 'send', target: 72, wake: true });
    expect(first.state).toEqual({ status: 'running-with-newer', desired: 74, inflight: 72 });
    const follow = reducePendingTarget(first.state, {
      type: 'settled',
      stoppedAt: 72,
      status: 'done',
      limits: { ...cap, pressCap: 3 },
    });
    expect(follow.effect).toEqual({ type: 'send', target: 74, wake: false });
    expect(follow.state).toEqual({ status: 'running', desired: 74, inflight: 74 });
    const done = reducePendingTarget(follow.state, {
      type: 'settled',
      stoppedAt: 74,
      status: 'done',
      limits: cap,
    });
    expect(done.state).toEqual({ status: 'idle' });
    expect(done.effect).toEqual({ type: 'clear-timer' });
  });

  it('keeps a newer desired while a command runs and sends the remainder once', () => {
    let state = elapsed(bump(bump(bump(idlePending(), 1).state, 1).state, 1).state).state;
    expect(state.status).toBe('running');
    const during = bump(bump(state, 1, 70).state, 1, 70);
    expect(during.effect).toEqual({ type: 'none' });
    expect(during.state).toEqual({ status: 'running-with-newer', desired: 75, inflight: 73 });
    const again = elapsed(during.state, 71);
    expect(again.state).toBe(during.state);
    expect(again.effect).toEqual({ type: 'none' });
    const follow = reducePendingTarget(during.state, {
      type: 'settled',
      stoppedAt: 73,
      status: 'done',
      limits: cap,
    });
    expect(follow.effect).toEqual({ type: 'send', target: 75, wake: false });
  });

  it('does not retry a command that stopped short unless a newer target is still waiting', () => {
    const running = elapsed(bump(bump(bump(idlePending(), 1).state, 1).state, 1).state).state;
    const failed = reducePendingTarget(running, {
      type: 'settled',
      stoppedAt: 71,
      status: 'failed',
      limits: cap,
    });
    expect(failed.state.status).toBe('idle');
    expect(failed.effect.type).not.toBe('send');
    const ambiguous = reducePendingTarget(
      { status: 'running-with-newer', desired: 75, inflight: 73 },
      { type: 'settled', stoppedAt: 71, status: 'ambiguous', limits: cap },
    );
    expect(ambiguous.state.status).toBe('idle');
    const short = reducePendingTarget(
      { status: 'running-with-newer', desired: 80, inflight: 73 },
      { type: 'settled', stoppedAt: 70, status: 'done', limits: cap },
    );
    expect(short.state.status).toBe('idle');
    expect(short.effect.type).not.toBe('send');
  });

  it('clears desired on cancel and when another client holds the lease', () => {
    const pending = bump(idlePending(), 1).state;
    expect(reducePendingTarget(pending, { type: 'cancel' }).state).toEqual({ status: 'idle' });
    const newer: PendingTarget = { status: 'running-with-newer', desired: 75, inflight: 73 };
    expect(reducePendingTarget(newer, { type: 'cancel' })).toEqual({
      state: { status: 'idle' },
      effect: { type: 'clear-timer' },
    });
    expect(reducePendingTarget(newer, { type: 'foreign-busy' }).state).toEqual({ status: 'idle' });
    expect(dropsDesiredOnBusy('foreign')).toBe(true);
    expect(dropsDesiredOnBusy('self')).toBe(false);
  });

  it('drops a debounced target when an explicit command takes the session', () => {
    const pending = bump(bump(idlePending(), 1).state, 1).state;
    const taken = reducePendingTarget(pending, { type: 'arm-external', target: 66 });
    expect(taken.state).toEqual({ status: 'running', desired: 66, inflight: 66 });
    expect(taken.effect).toEqual({ type: 'clear-timer' });
    const ignored = reducePendingTarget(taken.state, { type: 'arm-external', target: 60 });
    expect(ignored.state).toBe(taken.state);
    expect(ignored.effect).toEqual({ type: 'none' });
  });

  it('defers a pending target onto an in-flight command instead of sending a second one', () => {
    const pending = bump(bump(idlePending(), 1).state, -1).state;
    expect(pending).toEqual({ status: 'idle' });
    const queued = bump(bump(idlePending(), 1).state, 1).state;
    const deferred = reducePendingTarget(queued, { type: 'defer', inflight: 71 });
    expect(deferred.effect).toEqual({ type: 'clear-timer' });
    expect(deferred.state).toEqual({ status: 'running-with-newer', desired: 72, inflight: 71 });
  });

  it('clamps a step at the rails and refuses a target the cap cannot start', () => {
    expect(stepSetpoint(85, 1, 1, 50, 85)).toBe(85);
    expect(stepSetpoint(50, -1, 1, 50, 85)).toBe(50);
    expect(bump(idlePending(), 1, 85).state.status).toBe('idle');
    expect(boundedTarget({ from: 70, desired: 74, step: 1, pressCap: 3, wake: true })).toBe(72);
    expect(boundedTarget({ from: 70, desired: 71, step: 1, pressCap: 1, wake: true })).toBe(70);
    const pending = bump(idlePending(), 1, 70, { wakeFirst: true, pressCap: 1 }).state;
    const refused = elapsed(pending, 70, { pressCap: 1 });
    expect(refused.state.status).toBe('idle');
    expect(refused.effect.type).toBe('refuse');
    if (refused.effect.type === 'refuse') {
      expect(refused.effect.reason).toContain('cap');
    }
  });

  it('repairs impossible combinations and ignores events that do not apply', () => {
    const repaired = reducePendingTarget(
      { status: 'running', desired: 74, inflight: 72 },
      { type: 'debounce-elapsed', from: 70, limits: cap },
    );
    expect(repaired.state).toEqual({ status: 'running-with-newer', desired: 74, inflight: 72 });
    expect(pendingInvariant(repaired.state)).toBe(true);
    const collapsed = reducePendingTarget(
      { status: 'running-with-newer', desired: 72, inflight: 72 },
      { type: 'cancel' },
    );
    expect(collapsed.state.status).toBe('idle');
    const pendingSame = reducePendingTarget(
      { status: 'pending', desired: 70, anchor: 70, wake: true },
      { type: 'bump', direction: 1, setpoint: 70, limits },
    );
    expect(pendingSame.state).toEqual({ status: 'pending', desired: 71, anchor: 70, wake: false });

    const idle = idlePending();
    const ignored: PendingEvent[] = [
      { type: 'debounce-elapsed', from: 70, limits: cap },
      { type: 'settled', stoppedAt: 70, status: 'done', limits: cap },
      { type: 'defer', inflight: 71 },
      { type: 'cancel' },
      { type: 'foreign-busy' },
      { type: 'bump', direction: 1, setpoint: null, limits },
    ];
    for (const event of ignored) {
      const step = reducePendingTarget(idle, event);
      expect(step.state).toBe(idle);
      expect(step.effect).toEqual({ type: 'none' });
      expect(pendingInvariant(step.state)).toBe(true);
    }
    const running: PendingTarget = { status: 'running', desired: 73, inflight: 73 };
    expect(reducePendingTarget(running, { type: 'arm-external', target: 80 }).state).toBe(running);
    expect(reducePendingTarget(running, { type: 'defer', inflight: 70 }).state).toBe(running);
    expect(schedulerBlocked(idle)).toBe(false);
    expect(schedulerBlocked(running)).toBe(true);
    expect(schedulerBlocked({ status: 'pending', desired: 71, anchor: 70, wake: false })).toBe(true);
  });

  it('keeps manual bumps available and shows the latest desired on the progress line', () => {
    expect(commandLocks({ commandVisible: false, desired: null })).toEqual({
      adjustments: false,
      replacements: false,
    });
    expect(commandLocks({ commandVisible: true, desired: 73 })).toEqual({
      adjustments: false,
      replacements: true,
    });
    expect(commandLocks({ commandVisible: false, desired: 73 })).toEqual({
      adjustments: false,
      replacements: true,
    });
    expect(shownProgressTarget(75, 73)).toBe(75);
    expect(shownProgressTarget(null, 73)).toBe(73);
    expect(commandContinuation({ resumeQueued: true, follow: true })).toBe('resume');
    expect(commandContinuation({ resumeQueued: false, follow: true })).toBe('follow');
    expect(commandContinuation({ resumeQueued: false, follow: false })).toBe('stop');
  });
});
