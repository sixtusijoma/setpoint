import { describe, expect, it } from 'vitest';

import { executePlan } from '@/domain/execute';
import { planSetTo, type PressAction } from '@/domain/planSetTo';

const settings = {
  step: 1,
  minF: 50,
  maxF: 85,
  pressCap: 15,
  wakeFirst: false,
};

function mustPlan(current: number, target: number, wakeFirst = false) {
  const plan = planSetTo({ ...settings, current, target, wakeFirst });
  if (!plan.ok) {
    throw new Error(plan.reason);
  }
  return plan;
}

describe('executePlan', () => {
  it('stops on a failed press and keeps only earlier setpoint updates', async () => {
    let calls = 0;
    const commits: PressAction[] = [];
    const plan = mustPlan(70, 74);
    const result = await executePlan(plan, 70, {
      delayMs: 1000,
      sleep: async () => false,
      isCancelled: () => false,
      onProgress: () => undefined,
      onCommitted: (action) => {
        commits.push(action);
      },
      pressUp: async () => {
        calls += 1;
        if (calls === 3) {
          throw new Error('The up bot did not respond.');
        }
      },
      pressDown: async () => undefined,
    });
    expect(result.status).toBe('failed');
    expect(result.completedPresses).toBe(2);
    expect(result.stoppedAt).toBe(72);
    expect(result.wanted).toBe(74);
    expect(commits.map((action) => action.setpointAfter)).toEqual([71, 72]);
  });

  it('cancels before the next press', async () => {
    const commits: number[] = [];
    const plan = mustPlan(70, 75);
    let committed = 0;
    const result = await executePlan(plan, 70, {
      delayMs: 1000,
      sleep: async (_ms, isCancelled) => isCancelled(),
      isCancelled: () => committed >= 2,
      onProgress: () => undefined,
      onCommitted: (action) => {
        if (action.setpointAfter !== null) {
          commits.push(action.setpointAfter);
          committed += 1;
        }
      },
      pressUp: async () => undefined,
      pressDown: async () => undefined,
    });
    expect(result.status).toBe('cancelled');
    expect(result.stoppedAt).toBe(72);
    expect(commits).toEqual([71, 72]);
  });

  it('does not move the setpoint when the wake press fails', async () => {
    const plan = mustPlan(70, 71, true);
    const commits: PressAction[] = [];
    const result = await executePlan(plan, 70, {
      delayMs: 0,
      sleep: async () => false,
      isCancelled: () => false,
      onProgress: () => undefined,
      onCommitted: (action) => {
        commits.push(action);
      },
      pressUp: async () => {
        throw new Error('wake failed');
      },
      pressDown: async () => undefined,
    });
    expect(result.status).toBe('failed');
    expect(result.stoppedAt).toBe(70);
    expect(commits).toEqual([]);
  });
});
