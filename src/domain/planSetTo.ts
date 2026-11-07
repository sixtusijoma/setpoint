export type Direction = 'up' | 'down';

export type PressAction = {
  kind: 'wake' | 'adjust';
  direction: Direction;
  setpointAfter: number | null;
};

export type SetPlan =
  | {
      ok: true;
      actions: PressAction[];
      target: number;
      totalPresses: number;
      direction: Direction | 'none';
    }
  | {
      ok: false;
      reason: string;
    };

export type PlanInput = {
  current: number;
  target: number;
  step: number;
  minF: number;
  maxF: number;
  pressCap: number;
  wakeFirst: boolean;
};

export function planSetTo(input: PlanInput): SetPlan {
  const { current, target, step, minF, maxF, pressCap, wakeFirst } = input;
  if (!Number.isInteger(step) || step < 1 || step > 5) {
    return { ok: false, reason: 'Step must be a whole number from 1 to 5°. No presses sent.' };
  }
  if (!Number.isInteger(current) || !Number.isInteger(target)) {
    return { ok: false, reason: 'Temperatures are whole degrees. No presses sent.' };
  }
  if (target < minF || target > maxF) {
    return {
      ok: false,
      reason: `${target}° is outside ${minF}–${maxF}°. No presses sent.`,
    };
  }
  const delta = target - current;
  if (delta === 0) {
    return { ok: true, actions: [], target, totalPresses: 0, direction: 'none' };
  }
  if (delta % step !== 0) {
    return {
      ok: false,
      reason: `${target}° does not line up with the ${step}° step from ${current}°. No presses sent.`,
    };
  }
  const adjustPresses = Math.abs(delta) / step;
  const wakePresses = wakeFirst ? 1 : 0;
  const totalPresses = adjustPresses + wakePresses;
  if (totalPresses > pressCap) {
    return {
      ok: false,
      reason: `That would take ${totalPresses} presses, over the cap of ${pressCap}. No presses sent.`,
    };
  }
  const direction: Direction = delta > 0 ? 'up' : 'down';
  const actions: PressAction[] = [];
  if (wakeFirst) {
    actions.push({ kind: 'wake', direction, setpointAfter: null });
  }
  const sign = delta > 0 ? 1 : -1;
  for (let index = 1; index <= adjustPresses; index += 1) {
    actions.push({
      kind: 'adjust',
      direction,
      setpointAfter: current + sign * step * index,
    });
  }
  return { ok: true, actions, target, totalPresses, direction };
}

export function nearestTarget(current: number, step: number, minF: number, maxF: number): number {
  let value = current;
  if (value > maxF) {
    while (value > maxF) {
      value -= step;
    }
  }
  if (value < minF) {
    while (value < minF) {
      value += step;
    }
  }
  if (value < minF || value > maxF) {
    return minF;
  }
  return value;
}
