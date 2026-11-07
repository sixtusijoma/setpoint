import { describe, expect, it } from 'vitest';

import { planSetTo } from '@/domain/planSetTo';

const base = {
  current: 70,
  step: 1,
  minF: 50,
  maxF: 85,
  pressCap: 15,
  wakeFirst: false,
};

describe('planSetTo', () => {
  it('plans upward presses from the virtual setpoint', () => {
    const plan = planSetTo({ ...base, target: 73 });
    expect(plan.ok).toBe(true);
    if (!plan.ok) {
      return;
    }
    expect(plan.direction).toBe('up');
    expect(plan.totalPresses).toBe(3);
    expect(plan.actions.map((action) => action.setpointAfter)).toEqual([71, 72, 73]);
  });

  it('plans downward presses', () => {
    const plan = planSetTo({ ...base, target: 67 });
    expect(plan.ok).toBe(true);
    if (!plan.ok) {
      return;
    }
    expect(plan.direction).toBe('down');
    expect(plan.actions.every((action) => action.direction === 'down')).toBe(true);
    expect(plan.actions[plan.actions.length - 1]?.setpointAfter).toBe(67);
  });

  it('sends nothing when the setpoint is already the target', () => {
    const plan = planSetTo({ ...base, target: 70, wakeFirst: true });
    expect(plan).toEqual({
      ok: true,
      actions: [],
      target: 70,
      totalPresses: 0,
      direction: 'none',
    });
  });

  it('refuses a target outside the range before any press', () => {
    const plan = planSetTo({ ...base, target: 86 });
    expect(plan.ok).toBe(false);
    if (plan.ok) {
      return;
    }
    expect(plan.reason).toContain('outside');
    expect(plan.reason).toContain('No presses sent');
  });

  it('refuses a command that would exceed the press cap', () => {
    const plan = planSetTo({ ...base, current: 70, target: 85, pressCap: 14 });
    expect(plan.ok).toBe(false);
    if (plan.ok) {
      return;
    }
    expect(plan.reason).toContain('cap');
  });

  it('does not change degrees on the wake press', () => {
    const plan = planSetTo({ ...base, target: 71, wakeFirst: true });
    expect(plan.ok).toBe(true);
    if (!plan.ok) {
      return;
    }
    expect(plan.totalPresses).toBe(2);
    expect(plan.actions[0]).toEqual({ kind: 'wake', direction: 'up', setpointAfter: null });
    expect(plan.actions[1]).toEqual({ kind: 'adjust', direction: 'up', setpointAfter: 71 });
  });

  it('counts the wake press toward the cap', () => {
    const allowed = planSetTo({ ...base, current: 70, target: 84, wakeFirst: true, pressCap: 15 });
    const refused = planSetTo({ ...base, current: 70, target: 85, wakeFirst: true, pressCap: 15 });
    expect(allowed.ok).toBe(true);
    if (allowed.ok) {
      expect(allowed.totalPresses).toBe(15);
    }
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.reason).toContain('16');
    }
  });

  it('refuses a target that is off the step', () => {
    const plan = planSetTo({ ...base, step: 2, target: 71 });
    expect(plan.ok).toBe(false);
  });
});
