import { planSetTo } from './planSetTo';

export const BUMP_DEBOUNCE_MS = 350;

export type PendingTarget =
  | { status: 'idle' }
  | { status: 'pending'; desired: number; anchor: number; wake: boolean }
  | { status: 'running'; desired: number; inflight: number }
  | { status: 'running-with-newer'; desired: number; inflight: number };

export type CapLimits = {
  step: number;
  min: number;
  max: number;
  pressCap: number;
};

export type StepLimits = CapLimits & {
  wakeFirst: boolean;
};

export type CommandEndStatus = 'done' | 'already' | 'cancelled' | 'failed' | 'refused' | 'busy' | 'ambiguous';

export type PendingEvent =
  | { type: 'bump'; direction: 1 | -1; setpoint: number | null; limits: StepLimits }
  | { type: 'debounce-elapsed'; from: number; limits: CapLimits }
  | { type: 'settled'; stoppedAt: number; status: CommandEndStatus; limits: CapLimits }
  | { type: 'defer'; inflight: number }
  | { type: 'arm-external'; target: number }
  | { type: 'cancel' }
  | { type: 'foreign-busy' };

export type PendingEffect =
  | { type: 'none' }
  | { type: 'arm-timer'; ms: number }
  | { type: 'clear-timer' }
  | { type: 'send'; target: number; wake: boolean }
  | { type: 'refuse'; reason: string };

export type PendingStep = {
  state: PendingTarget;
  effect: PendingEffect;
};

export function idlePending(): PendingTarget {
  return { status: 'idle' };
}

export function desiredSetpoint(state: PendingTarget): number | null {
  if (state.status === 'idle') {
    return null;
  }
  return state.desired;
}

export function pendingInvariant(state: PendingTarget): boolean {
  if (state.status === 'running') {
    return state.desired === state.inflight;
  }
  if (state.status === 'running-with-newer') {
    return state.desired !== state.inflight;
  }
  if (state.status === 'pending') {
    return state.desired !== state.anchor;
  }
  return state.status === 'idle';
}

export function schedulerBlocked(state: PendingTarget): boolean {
  return state.status !== 'idle';
}

export function shownProgressTarget(desired: number | null, commandTarget: number): number {
  return desired ?? commandTarget;
}

export function commandLocks(input: { commandVisible: boolean; desired: number | null }): {
  adjustments: boolean;
  replacements: boolean;
} {
  return {
    adjustments: false,
    replacements: input.commandVisible || input.desired !== null,
  };
}

export function dropsDesiredOnBusy(owner: 'self' | 'foreign'): boolean {
  return owner === 'foreign';
}

export function commandContinuation(input: { resumeQueued: boolean; follow: boolean }): 'resume' | 'follow' | 'stop' {
  if (input.resumeQueued) {
    return 'resume';
  }
  if (input.follow) {
    return 'follow';
  }
  return 'stop';
}

export function stepSetpoint(current: number, direction: 1 | -1, step: number, min: number, max: number): number {
  if (!Number.isInteger(step) || step < 1) {
    return current;
  }
  const next = current + direction * step;
  if (next > max || next < min) {
    return current;
  }
  return next;
}

export function boundedTarget(input: {
  from: number;
  desired: number;
  step: number;
  pressCap: number;
  wake: boolean;
}): number {
  const { from, desired, step, pressCap, wake } = input;
  if (!Number.isInteger(step) || step < 1 || desired === from) {
    return from;
  }
  const direction = desired > from ? 1 : -1;
  const stepsAway = Math.floor(Math.abs(desired - from) / step);
  const maxAdjust = Math.max(0, pressCap - (wake ? 1 : 0));
  const steps = Math.min(stepsAway, maxAdjust);
  return from + direction * steps * step;
}

function same(state: PendingTarget): PendingStep {
  return { state, effect: { type: 'none' } };
}

function cleared(): PendingStep {
  return { state: idlePending(), effect: { type: 'clear-timer' } };
}

function normalize(state: PendingTarget): PendingTarget {
  if (state.status === 'running' && state.desired !== state.inflight) {
    return { status: 'running-with-newer', desired: state.desired, inflight: state.inflight };
  }
  if (state.status === 'running-with-newer' && state.desired === state.inflight) {
    return { status: 'running', desired: state.desired, inflight: state.inflight };
  }
  if (state.status === 'pending' && state.desired === state.anchor) {
    return idlePending();
  }
  return state;
}

function unreachableReason(from: number, desired: number, limits: CapLimits, wake: boolean): string {
  const plan = planSetTo({
    current: from,
    target: desired,
    step: limits.step,
    minF: Math.min(limits.min, from, desired),
    maxF: Math.max(limits.max, from, desired),
    pressCap: limits.pressCap,
    wakeFirst: wake,
  });
  if (!plan.ok) {
    return plan.reason;
  }
  return `That would take more presses than the cap of ${limits.pressCap}. No presses sent.`;
}

function arm(desired: number, inflight: number, wake: boolean): PendingStep {
  const state: PendingTarget =
    desired === inflight
      ? { status: 'running', desired, inflight }
      : { status: 'running-with-newer', desired, inflight };
  return { state, effect: { type: 'send', target: inflight, wake } };
}

function continueToward(from: number, desired: number, limits: CapLimits, wake: boolean): PendingStep {
  if (desired === from) {
    return cleared();
  }
  const target = boundedTarget({ from, desired, step: limits.step, pressCap: limits.pressCap, wake });
  if (target === from) {
    return { state: idlePending(), effect: { type: 'refuse', reason: unreachableReason(from, desired, limits, wake) } };
  }
  return arm(desired, target, wake);
}

export function reducePendingTarget(input: PendingTarget, event: PendingEvent): PendingStep {
  const state = normalize(input);
  if (event.type === 'bump') {
    if (event.setpoint === null) {
      return same(state);
    }
    const { limits } = event;
    const base = state.status === 'idle' ? event.setpoint : state.desired;
    const next = stepSetpoint(base, event.direction, limits.step, limits.min, limits.max);
    if (state.status === 'idle') {
      if (next === event.setpoint) {
        return same(state);
      }
      return {
        state: { status: 'pending', desired: next, anchor: event.setpoint, wake: limits.wakeFirst },
        effect: { type: 'arm-timer', ms: BUMP_DEBOUNCE_MS },
      };
    }
    if (state.status === 'pending') {
      if (next === state.anchor) {
        return cleared();
      }
      return {
        state: { status: 'pending', desired: next, anchor: state.anchor, wake: state.wake },
        effect: { type: 'arm-timer', ms: BUMP_DEBOUNCE_MS },
      };
    }
    if (next === state.inflight) {
      const running: PendingTarget = { status: 'running', desired: next, inflight: state.inflight };
      if (state.status === 'running' && state.desired === next) {
        return same(state);
      }
      return { state: running, effect: { type: 'none' } };
    }
    return {
      state: { status: 'running-with-newer', desired: next, inflight: state.inflight },
      effect: { type: 'none' },
    };
  }

  if (event.type === 'debounce-elapsed') {
    if (state.status !== 'pending') {
      return same(state);
    }
    return continueToward(event.from, state.desired, event.limits, state.wake);
  }

  if (event.type === 'defer') {
    if (state.status !== 'pending') {
      return same(state);
    }
    if (state.desired === event.inflight) {
      return { state: { status: 'running', desired: state.desired, inflight: event.inflight }, effect: { type: 'clear-timer' } };
    }
    return {
      state: { status: 'running-with-newer', desired: state.desired, inflight: event.inflight },
      effect: { type: 'clear-timer' },
    };
  }

  if (event.type === 'arm-external') {
    if (state.status === 'running' || state.status === 'running-with-newer') {
      return same(state);
    }
    return {
      state: { status: 'running', desired: event.target, inflight: event.target },
      effect: { type: 'clear-timer' },
    };
  }

  if (event.type === 'cancel' || event.type === 'foreign-busy') {
    if (state.status === 'idle') {
      return same(state);
    }
    return cleared();
  }

  if (event.type === 'settled') {
    if (state.status !== 'running' && state.status !== 'running-with-newer') {
      return same(state);
    }
    if (event.status !== 'done' && event.status !== 'already') {
      return cleared();
    }
    if (state.status === 'running' || event.stoppedAt === state.desired || event.stoppedAt !== state.inflight) {
      return cleared();
    }
    return continueToward(event.stoppedAt, state.desired, event.limits, false);
  }

  return same(state);
}
