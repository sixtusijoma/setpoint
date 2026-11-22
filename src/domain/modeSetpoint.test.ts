import { describe, expect, it } from 'vitest';

import {
  OFF_SETPOINT_REASON,
  UNKNOWN_MODE_REASON,
  activeDegrees,
  migrateSingleSetpoint,
  reduceClimate,
  resolveActive,
  type ClimateControl,
} from './modeSetpoint';

function climate(patch: Partial<ClimateControl> = {}): ClimateControl {
  return {
    systemMode: 'heat',
    setpoints: { heat: 70, cool: 74 },
    ...patch,
  };
}

describe('per-mode setpoints', () => {
  it('copies one saved number onto both modes', () => {
    expect(migrateSingleSetpoint(68)).toEqual({ heat: 68, cool: 68 });
    expect(migrateSingleSetpoint(null)).toEqual({ heat: null, cool: null });
  });

  it('shows only the active mode and keeps the other number', () => {
    expect(resolveActive('heat', { heat: 70, cool: 74 })).toEqual({ status: 'active', mode: 'heat', degrees: 70 });
    expect(resolveActive('cool', { heat: 70, cool: 74 })).toEqual({ status: 'active', mode: 'cool', degrees: 74 });
    expect(resolveActive('off', { heat: 70, cool: 74 })).toEqual({ status: 'off' });
    expect(resolveActive('unknown', { heat: 70, cool: 74 })).toEqual({ status: 'unknown' });
    expect(activeDegrees('cool', { heat: 70, cool: null })).toBeNull();
  });

  it('refuses temperature writes while Off or unknown and does not change either setpoint', () => {
    const off = climate({ systemMode: 'off' });
    const unknown = climate({ systemMode: 'unknown' });
    expect(reduceClimate(off, { type: 'set-active', kind: 'adjust', degrees: 72 })).toEqual({
      state: off,
      reason: OFF_SETPOINT_REASON,
    });
    expect(reduceClimate(unknown, { type: 'set-active', kind: 'recalibrate', degrees: 72 }).state).toEqual(unknown);
    expect(reduceClimate(off, { type: 'commit-press', step: 1 }).state).toEqual({ ...off, systemMode: 'cool' });
    expect(reduceClimate(unknown, { type: 'commit-press', step: 2 })).toEqual({
      state: unknown,
      reason: UNKNOWN_MODE_REASON,
    });
  });

  it('writes the active mode only, then follows a mode press', () => {
    const heated = reduceClimate(climate(), { type: 'set-active', kind: 'adjust', degrees: 71 });
    expect(heated.reason).toBeNull();
    expect(heated.state.setpoints).toEqual({ heat: 71, cool: 74 });
    const cooled = reduceClimate(heated.state, { type: 'commit-press', step: 2 });
    expect(cooled.state.systemMode).toBe('cool');
    expect(cooled.state.setpoints).toEqual({ heat: 71, cool: 74 });
    expect(activeDegrees(cooled.state.systemMode, cooled.state.setpoints)).toBe(74);
  });

  it('seeds both modes without inventing a system mode', () => {
    const seeded = reduceClimate(climate({ systemMode: 'unknown', setpoints: { heat: null, cool: null } }), {
      type: 'seed',
      degrees: 70,
    });
    expect(seeded.state).toEqual({ systemMode: 'unknown', setpoints: { heat: 70, cool: 70 } });
    const named = reduceClimate(seeded.state, { type: 'recalibrate-mode', mode: 'cool' });
    expect(named.state.systemMode).toBe('cool');
    expect(named.state.setpoints).toEqual({ heat: 70, cool: 70 });
  });

  it('records the mode and either setpoint together, including while Off', () => {
    const saved = reduceClimate(climate(), { type: 'recalibrate-record', mode: 'cool', heat: 68, cool: 74 });
    expect(saved.reason).toBeNull();
    expect(saved.state).toEqual({ systemMode: 'cool', setpoints: { heat: 68, cool: 74 } });
    const off = reduceClimate(climate({ systemMode: 'off' }), {
      type: 'recalibrate-record',
      mode: null,
      heat: 69,
      cool: null,
    });
    expect(off.state).toEqual({ systemMode: 'off', setpoints: { heat: 69, cool: 74 } });
    expect(reduceClimate(climate(), { type: 'recalibrate-record', mode: null, heat: 68.5, cool: null })).toEqual({
      state: climate(),
      reason: 'Temperatures are whole degrees.',
    });
  });

  it('does not adjust a mode that has no number yet', () => {
    const blank = climate({ setpoints: { heat: null, cool: 74 } });
    const refused = reduceClimate(blank, { type: 'set-active', kind: 'adjust', degrees: 71 });
    expect(refused.state).toEqual(blank);
    expect(refused.reason).toMatch(/Heat setpoint/);
    const saved = reduceClimate(blank, { type: 'set-active', kind: 'recalibrate', degrees: 66 });
    expect(saved.state.setpoints.heat).toBe(66);
    expect(saved.state.setpoints.cool).toBe(74);
  });
});
