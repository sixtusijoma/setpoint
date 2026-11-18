import { describe, expect, it } from 'vitest';

import { advanceMode, modeStepOf, pressesToMode, reduceTrackedMode, trackedFrom } from './systemMode';

describe('thermostat mode cycle', () => {
  it('steps one real press forward as Heat, Off, Cool', () => {
    expect(advanceMode('heat', 1)).toBe('off');
    expect(advanceMode('off', 1)).toBe('cool');
    expect(advanceMode('cool', 1)).toBe('heat');
  });

  it('steps the over-pressing bot two modes forward', () => {
    expect(advanceMode('heat', 2)).toBe('cool');
    expect(advanceMode('cool', 2)).toBe('off');
    expect(advanceMode('off', 2)).toBe('heat');
  });

  it('counts the shortest press sequence for each step', () => {
    expect(pressesToMode('heat', 'heat', 2)).toBe(0);
    expect(pressesToMode('heat', 'cool', 2)).toBe(1);
    expect(pressesToMode('heat', 'off', 2)).toBe(2);
    expect(pressesToMode('cool', 'off', 2)).toBe(1);
    expect(pressesToMode('off', 'heat', 2)).toBe(1);
    expect(pressesToMode('heat', 'off', 1)).toBe(1);
    expect(pressesToMode('heat', 'cool', 1)).toBe(2);
    expect(pressesToMode('cool', 'heat', 1)).toBe(1);
  });

  it('recalibrates from unknown and refuses to advance an unknown mode', () => {
    const unknown = trackedFrom('unknown');
    expect(reduceTrackedMode(unknown, { type: 'advance', step: 2 })).toEqual(unknown);
    const heat = reduceTrackedMode(unknown, { type: 'recalibrate', mode: 'heat' });
    expect(heat).toEqual({ status: 'known', mode: 'heat' });
    expect(reduceTrackedMode(heat, { type: 'advance', step: 2 })).toEqual({ status: 'known', mode: 'cool' });
    expect(reduceTrackedMode(heat, { type: 'advance', step: 1 })).toEqual({ status: 'known', mode: 'off' });
  });

  it('keeps a known mode when a recalibrate value is not a mode', () => {
    const heat = trackedFrom('heat');
    expect(reduceTrackedMode(heat, { type: 'recalibrate', mode: 'heat' })).toEqual(heat);
    expect(modeStepOf(undefined)).toBe(2);
    expect(modeStepOf(1)).toBe(1);
    expect(modeStepOf(3)).toBe(2);
  });
});
