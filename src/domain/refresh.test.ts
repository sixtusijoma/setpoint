import { describe, expect, it } from 'vitest';

import { initialRefresh, reduceRefresh, refreshSpinner, type Refresh, type RefreshEvent, type RefreshPhase } from '@/domain/refresh';

function assertPossible(state: Refresh): void {
  expect(['idle', 'background', 'user']).toContain(state.phase);
  expect(Number.isInteger(state.epoch)).toBe(true);
  expect(state.epoch).toBeGreaterThanOrEqual(0);
  expect(refreshSpinner(state.phase)).toBe(state.phase === 'user');
}

describe('climate refresh', () => {
  const idle = initialRefresh();

  it('starts idle and only a user pull shows the spinner', () => {
    expect(idle).toEqual({ phase: 'idle', epoch: 0 });
    expect(refreshSpinner(idle.phase)).toBe(false);
    const background = reduceRefresh(idle, { type: 'start', source: 'background' });
    expect(background).toEqual({ phase: 'background', epoch: 1 });
    expect(refreshSpinner(background.phase)).toBe(false);
    const user = reduceRefresh(idle, { type: 'start', source: 'user' });
    expect(user).toEqual({ phase: 'user', epoch: 1 });
    expect(refreshSpinner(user.phase)).toBe(true);
  });

  it('settles the request that started and ignores a stale finish', () => {
    const background = reduceRefresh(idle, { type: 'start', source: 'background' });
    const settled = reduceRefresh(background, { type: 'settle', epoch: background.epoch });
    expect(settled).toEqual({ phase: 'idle', epoch: background.epoch });
    expect(reduceRefresh(settled, { type: 'settle', epoch: background.epoch })).toBe(settled);
    const again = reduceRefresh(settled, { type: 'start', source: 'user' });
    expect(reduceRefresh(again, { type: 'settle', epoch: background.epoch })).toBe(again);
    expect(reduceRefresh(again, { type: 'settle', epoch: Number.NaN })).toBe(again);
  });

  it('promotes an in-flight background refresh when the user pulls', () => {
    const background = reduceRefresh(idle, { type: 'start', source: 'background' });
    const promoted = reduceRefresh(background, { type: 'start', source: 'user' });
    expect(promoted).toEqual({ phase: 'user', epoch: background.epoch });
    expect(refreshSpinner(promoted.phase)).toBe(true);
    expect(reduceRefresh(promoted, { type: 'start', source: 'background' })).toBe(promoted);
    const settled = reduceRefresh(promoted, { type: 'settle', epoch: background.epoch });
    expect(settled).toEqual({ phase: 'idle', epoch: background.epoch });
    expect(refreshSpinner(settled.phase)).toBe(false);
  });

  it('does not let a background refresh replace a user pull', () => {
    const user = reduceRefresh(idle, { type: 'start', source: 'user' });
    expect(reduceRefresh(user, { type: 'start', source: 'background' })).toBe(user);
    expect(reduceRefresh(user, { type: 'start', source: 'user' })).toBe(user);
    const background = reduceRefresh(idle, { type: 'start', source: 'background' });
    expect(reduceRefresh(background, { type: 'start', source: 'background' })).toBe(background);
  });

  it('never reaches an impossible state', () => {
    const phases: RefreshPhase[] = ['idle', 'background', 'user'];
    const states: Refresh[] = phases.map((phase, index) => ({ phase, epoch: index }));
    const events: RefreshEvent[] = [
      { type: 'start', source: 'background' },
      { type: 'start', source: 'user' },
      { type: 'settle', epoch: 0 },
      { type: 'settle', epoch: 1 },
      { type: 'settle', epoch: 2 },
      { type: 'settle', epoch: 99 },
      { type: 'settle', epoch: Number.NaN },
    ];
    for (const state of states) {
      for (const event of events) {
        const next = reduceRefresh(state, event);
        assertPossible(next);
        if (event.type === 'settle' && (state.phase === 'idle' || state.epoch !== event.epoch)) {
          expect(next).toBe(state);
        }
        if (event.type === 'start' && event.source === 'background' && state.phase !== 'idle') {
          expect(next).toBe(state);
        }
        if (event.type === 'start' && event.source === 'user' && state.phase === 'user') {
          expect(next).toBe(state);
        }
        if (next.phase === 'idle') {
          expect(refreshSpinner(next.phase)).toBe(false);
        }
      }
    }
  });
});
