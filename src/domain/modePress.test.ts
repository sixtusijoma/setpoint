import { describe, expect, it } from 'vitest';

import {
  beginModeSession,
  idleModeSession,
  isModeRunning,
  modePressGapMs,
  MODE_PRESS_SPACING_MS,
  reduceModeSession,
  runModeSession,
  type ModeSession,
} from './modePress';

const source = { kind: 'set-mode' as const };

function armed(): ModeSession {
  return reduceModeSession(idleModeSession(), {
    type: 'start',
    from: 'heat',
    target: 'off',
    step: 2,
    source,
  });
}

describe('mode press session', () => {
  it('arms Heat to Off as two over-presses and shows press 1 immediately', () => {
    const opened = beginModeSession({ from: 'heat', target: 'off', step: 2, source });
    expect(opened?.progress).toEqual({ index: 1, total: 2, target: 'off', label: 'press' });
    expect(opened?.session.tracked).toBe('heat');
    expect(beginModeSession({ from: 'heat', target: 'heat', step: 2, source })).toBeNull();
    expect(modePressGapMs(1000)).toBe(MODE_PRESS_SPACING_MS);
  });

  it('ignores a second start and a success that is not in flight', () => {
    const session = armed();
    expect(reduceModeSession(session, { type: 'start', from: 'cool', target: 'heat', step: 1, source })).toBe(session);
    expect(reduceModeSession(session, { type: 'success' })).toBe(session);
    expect(reduceModeSession(idleModeSession(), { type: 'success' })).toEqual(idleModeSession());
    expect(reduceModeSession(idleModeSession(), { type: 'cancel' })).toEqual(idleModeSession());
  });

  it('cancels before the first press and lets an in-flight press land', () => {
    const cancelled = reduceModeSession(armed(), { type: 'cancel' });
    expect(cancelled.phase).toBe('settled');
    if (cancelled.phase === 'settled') {
      expect(cancelled.status).toBe('cancelled');
      expect(cancelled.tracked).toBe('heat');
      expect(cancelled.committed).toBe(0);
    }
    const inflight = reduceModeSession(armed(), { type: 'begin-send' });
    const finishing = reduceModeSession(inflight, { type: 'cancel' });
    expect(isModeRunning(finishing) && finishing.cancelRequested).toBe(true);
    const landed = reduceModeSession(finishing, { type: 'success' });
    expect(landed.phase).toBe('settled');
    if (landed.phase === 'settled') {
      expect(landed.status).toBe('cancelled');
      expect(landed.tracked).toBe('cool');
      expect(landed.committed).toBe(1);
    }
  });

  it('advances only after a successful press and stops on a rejected or ambiguous one', () => {
    const sent = reduceModeSession(armed(), { type: 'begin-send' });
    const waiting = reduceModeSession(sent, { type: 'success' });
    expect(waiting.phase).toBe('waiting');
    if (waiting.phase === 'waiting') {
      expect(waiting.tracked).toBe('cool');
      expect(waiting.index).toBe(1);
    }
    const rejected = reduceModeSession(sent, { type: 'rejected', reason: 'The mode bot did not respond.' });
    expect(rejected.phase).toBe('settled');
    if (rejected.phase === 'settled') {
      expect(rejected.tracked).toBe('heat');
      expect(rejected.notifyCheck).toBe(false);
    }
    const ambiguous = reduceModeSession(sent, { type: 'ambiguous', reason: 'The response was lost.' });
    if (ambiguous.phase === 'settled') {
      expect(ambiguous.status).toBe('ambiguous');
      expect(ambiguous.tracked).toBe('heat');
      expect(ambiguous.notifyCheck).toBe(true);
    }
  });

  it('refuses to press when the mode is unknown', async () => {
    const presses: number[] = [];
    const settled = await runModeSession({
      from: 'unknown',
      target: 'heat',
      step: 2,
      source,
      delayMs: 0,
      press: async () => {
        presses.push(1);
      },
      sleep: async () => false,
      beforeSend: async () => false,
      isCancelled: () => false,
      isInterrupted: () => false,
      onSession: () => undefined,
    });
    expect(settled.status).toBe('refused');
    expect(presses).toEqual([]);
    expect(settled.tracked).toBe('unknown');
  });

  it('presses the bot once per step and commits the mode after each success', async () => {
    const seen: string[] = [];
    const settled = await runModeSession({
      from: 'heat',
      target: 'off',
      step: 2,
      source: { kind: 'mcp' },
      delayMs: 0,
      press: async () => undefined,
      sleep: async () => false,
      beforeSend: async () => false,
      isCancelled: () => false,
      isInterrupted: () => false,
      onSession: (session) => {
        if (session.phase !== 'idle') {
          seen.push(session.phase === 'settled' ? session.status : `${session.phase}:${session.tracked}`);
        }
      },
      onCommitted: (mode) => {
        seen.push(`commit:${mode}`);
      },
    });
    expect(settled.status).toBe('done');
    expect(settled.tracked).toBe('off');
    expect(settled.committed).toBe(2);
    expect(seen).toContain('commit:cool');
    expect(seen).toContain('commit:off');
  });
});
