import { describe, expect, it } from 'vitest';

import { createDefaultState } from './model';
import { appliedWrite, recordRecalibration, type RecalibrateWrite } from './recalibrateRecord';

function tracked(patch: Partial<ReturnType<typeof createDefaultState>> = {}) {
  return {
    ...createDefaultState('2026-11-12T14:00:00.000Z'),
    systemMode: 'heat' as const,
    heatSetpoint: 70,
    coolSetpoint: 76,
    virtualSetpoint: 70,
    ...patch,
  };
}

const at = '2026-11-22T16:00:00.000Z';

describe('recalibrate record', () => {
  it('writes the mode and both setpoints, and logs each temperature', () => {
    const prev = tracked();
    const next = recordRecalibration(prev, { mode: 'cool', heat: 68, cool: 74 }, at);
    expect(next.systemMode).toBe('cool');
    expect(next.heatSetpoint).toBe(68);
    expect(next.coolSetpoint).toBe(74);
    expect(next.virtualSetpoint).toBe(74);
    expect(next.changes.slice(-2)).toEqual([
      { at, setpoint: 68, source: 'recalibrated', label: 'Recalibrated Heat · 68°' },
      { at, setpoint: 74, source: 'recalibrated', label: 'Recalibrated Cool · 74°' },
    ]);
    expect(next.log[0]).toMatchObject({
      kind: 'calibration',
      message: 'The thermostat is Cool. Recalibrated Heat to 68° and Cool to 74°. No buttons were pressed.',
    });
  });

  it('writes one setpoint without touching the mode or the other number', () => {
    const prev = tracked();
    const next = recordRecalibration(prev, { mode: null, heat: null, cool: 74 }, at);
    expect(next.systemMode).toBe('heat');
    expect(next.heatSetpoint).toBe(70);
    expect(next.coolSetpoint).toBe(74);
    expect(next.virtualSetpoint).toBe(70);
    expect(next.changes).toEqual([{ at, setpoint: 74, source: 'recalibrated', label: 'Recalibrated Cool · 74°' }]);
    expect(next.log[0]?.message).toBe('Recalibrated the Cool setpoint to 74°. No buttons were pressed.');
  });

  it('records Off and keeps both stored setpoints on the dial as off', () => {
    const next = recordRecalibration(tracked(), { mode: 'off', heat: 68, cool: null }, at);
    expect(next.systemMode).toBe('off');
    expect(next.heatSetpoint).toBe(68);
    expect(next.coolSetpoint).toBe(76);
    expect(next.virtualSetpoint).toBeNull();
    expect(next.changes.map((change) => change.label)).toEqual(['Recalibrated Heat · 68°']);
    expect(next.log[0]?.message).toBe('The thermostat is Off. Recalibrated the Heat setpoint to 68°. No buttons were pressed.');
  });

  it('leaves the record alone when nothing was asked for', () => {
    const prev = tracked();
    const write: RecalibrateWrite = { mode: null, heat: null, cool: null };
    expect(recordRecalibration(prev, write, at)).toBe(prev);
  });

  it('applies only the numbers the server returned, and ignores a missing field', () => {
    const prev = { systemMode: 'heat' as const, heatSetpoint: 70, coolSetpoint: 76 };
    expect(appliedWrite(prev, { systemMode: 'cool', heatSetpoint: 68, coolSetpoint: 76 })).toEqual({
      mode: 'cool',
      heat: 68,
      cool: null,
    });
    expect(appliedWrite(prev, {})).toEqual({ mode: null, heat: null, cool: null });
    expect(appliedWrite(prev, { heatSetpoint: null, coolSetpoint: 74 })).toEqual({
      mode: null,
      heat: null,
      cool: 74,
    });
  });
});
