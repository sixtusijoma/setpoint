import { describe, expect, it } from 'vitest';

import {
  CONNECTION_DOWN_AFTER_MS,
  CONNECTION_FAILURES_BEFORE_DOWN,
  connectionBanner,
  initialConnection,
  reduceConnection,
  type Connection,
  type ConnectionEvent,
} from '@/domain/connection';

const lost = 'fetch failed: The network connection was lost.';
const again = 'Network request failed';
const t0 = 1_700_000_000_000;

function transient(error: string, at: number): ConnectionEvent {
  return { type: 'transient-failure', error, at };
}

function assertPossible(state: Connection): void {
  if (state.status === 'ok') {
    expect(state).toEqual({ status: 'ok' });
    return;
  }
  if (state.status === 'flaky') {
    expect(state.failures).toBeGreaterThanOrEqual(1);
    expect(state.failures).toBeLessThan(CONNECTION_FAILURES_BEFORE_DOWN);
    expect(Number.isFinite(state.since)).toBe(true);
    expect(state.lastError.length).toBeGreaterThan(0);
    return;
  }
  expect(state.error.length).toBeGreaterThan(0);
  expect(state).not.toHaveProperty('failures');
  expect(state).not.toHaveProperty('since');
  expect(state).not.toHaveProperty('lastError');
}

describe('connection health', () => {
  const ok = initialConnection();

  it('starts healthy with no banner', () => {
    expect(ok).toEqual({ status: 'ok' });
    expect(connectionBanner(ok)).toBeNull();
  });

  it('shows no banner for one transient failure followed by success', () => {
    const flaky = reduceConnection(ok, transient(lost, t0));
    expect(flaky).toEqual({ status: 'flaky', failures: 1, since: t0, lastError: lost });
    expect(connectionBanner(flaky)).toBeNull();
    const recovered = reduceConnection(flaky, { type: 'success' });
    expect(recovered).toEqual({ status: 'ok' });
    expect(connectionBanner(recovered)).toBeNull();
  });

  it('shows the banner after two consecutive transient failures', () => {
    const once = reduceConnection(ok, transient(lost, t0));
    const twice = reduceConnection(once, transient(again, t0 + 20));
    expect(twice).toEqual({ status: 'down', error: again });
    expect(connectionBanner(twice)).toBe(again);
  });

  it('shows the banner when one failure has lasted 10 seconds', () => {
    const flaky = reduceConnection(ok, transient(lost, t0));
    const waiting = reduceConnection(flaky, { type: 'foreground', at: t0 + CONNECTION_DOWN_AFTER_MS - 1 });
    expect(waiting).toBe(flaky);
    expect(connectionBanner(waiting)).toBeNull();
    const down = reduceConnection(flaky, { type: 'foreground', at: t0 + CONNECTION_DOWN_AFTER_MS });
    expect(down).toEqual({ status: 'down', error: lost });
    expect(connectionBanner(down)).toBe(lost);
  });

  it('returns to ok on success from every state', () => {
    const flaky = reduceConnection(ok, transient(lost, t0));
    const down = reduceConnection(flaky, { type: 'hard-failure', error: 'Server request failed (500).' });
    expect(reduceConnection(ok, { type: 'success' })).toBe(ok);
    expect(reduceConnection(flaky, { type: 'success' })).toEqual({ status: 'ok' });
    expect(reduceConnection(down, { type: 'success' })).toEqual({ status: 'ok' });
    expect(connectionBanner(reduceConnection(down, { type: 'success' }))).toBeNull();
  });

  it('shows a hard failure immediately and hides it on dismiss', () => {
    const down = reduceConnection(ok, { type: 'hard-failure', error: 'Server request failed (500).' });
    expect(connectionBanner(down)).toBe('Server request failed (500).');
    const cleared = reduceConnection(down, { type: 'dismiss' });
    expect(cleared).toEqual({ status: 'ok' });
    expect(connectionBanner(cleared)).toBeNull();
  });

  it('keeps later transient failures down until success or dismiss', () => {
    const down = reduceConnection(ok, { type: 'hard-failure', error: lost });
    const still = reduceConnection(down, transient(again, t0 + 50_000));
    expect(still).toEqual({ status: 'down', error: again });
    expect(reduceConnection(down, { type: 'foreground', at: t0 + 50_000 })).toBe(down);
    expect(reduceConnection(ok, { type: 'dismiss' })).toBe(ok);
    expect(reduceConnection(reduceConnection(ok, transient(lost, t0)), { type: 'dismiss' }).status).toBe('flaky');
  });

  it('never reaches an impossible state', () => {
    const flaky = reduceConnection(ok, transient(lost, t0));
    const down = reduceConnection(flaky, transient(lost, t0 + 1));
    const states = [ok, flaky, down];
    const events: ConnectionEvent[] = [
      { type: 'success' },
      transient(lost, t0 - 5_000),
      transient(again, t0 + 1),
      transient(lost, t0 + CONNECTION_DOWN_AFTER_MS + 5),
      transient(lost, Number.NaN),
      { type: 'hard-failure', error: 'Server request failed (503).' },
      { type: 'foreground', at: t0 },
      { type: 'foreground', at: t0 + CONNECTION_DOWN_AFTER_MS },
      { type: 'foreground', at: Number.NaN },
      { type: 'dismiss' },
    ];
    for (const state of states) {
      for (const event of events) {
        const next = reduceConnection(state, event);
        assertPossible(next);
        if (event.type === 'success') {
          expect(next.status).toBe('ok');
        }
        if (event.type === 'hard-failure') {
          expect(next.status).toBe('down');
        }
        if (event.type === 'transient-failure' && state.status === 'ok') {
          expect(next.status).toBe(Number.isFinite(event.at) ? 'flaky' : 'ok');
        }
        if (event.type === 'transient-failure' && state.status === 'down') {
          expect(next.status).toBe('down');
        }
        if ((event.type === 'foreground' || event.type === 'dismiss') && state.status === 'ok') {
          expect(next).toBe(state);
        }
        if (event.type === 'foreground' && state.status === 'down') {
          expect(next).toBe(state);
        }
        if (event.type === 'dismiss' && state.status === 'down') {
          expect(next.status).toBe('ok');
        }
      }
    }
  });
});
