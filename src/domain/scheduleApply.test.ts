import { describe, expect, it } from 'vitest';

import {
  alreadyCopy,
  ambiguousCopy,
  doneCopy,
  idleScheduleApply,
  performScheduleApply,
  reduceScheduleApply,
  type ScheduleApplyEvent,
  type ScheduleApplyState,
  type ScheduleClimate,
} from '@/domain/scheduleApply';
import type { KnownMode } from '@/domain/systemMode';

const heat: ScheduleClimate = { systemMode: 'heat', heatSetpoint: 70, coolSetpoint: 74 };
const off: ScheduleClimate = { systemMode: 'off', heatSetpoint: 70, coolSetpoint: 74 };
const unknown: ScheduleClimate = { systemMode: 'unknown', heatSetpoint: 70, coolSetpoint: 74 };

function start(mode: KnownMode | null, targetF: number, climate: ScheduleClimate = heat): ScheduleApplyState {
  return reduceScheduleApply(idleScheduleApply(), { type: 'start', mode, targetF, climate });
}

describe('reduceScheduleApply', () => {
  it('keeps a temperature-only event on the existing path', () => {
    expect(start(null, 70).phase).toBe('settled');
    const same = start(null, 70);
    if (same.phase === 'settled') {
      expect(same.result.status).toBe('already');
      expect(same.result.step).toBe('none');
      expect(same.result.notifyCheck).toBe(false);
    }
    const move = start(null, 72);
    expect(move.phase).toBe('set-temperature');
    const blocked = start(null, 72, off);
    if (blocked.phase === 'settled') {
      expect(blocked.result.status).toBe('refused');
      expect(blocked.result.step).toBe('none');
    }
  });

  it('skips the mode press when the thermostat is already in that mode', () => {
    const sameTemp = start('heat', 70);
    if (sameTemp.phase === 'settled') {
      expect(sameTemp.result).toMatchObject({ status: 'already', step: 'none', modeNote: { kind: 'already', mode: 'heat' } });
    }
    const different = start('heat', 68);
    expect(different.phase).toBe('set-temperature');
    const alreadyOff = start('off', 66, off);
    if (alreadyOff.phase === 'settled') {
      expect(alreadyOff.result).toMatchObject({ status: 'already', step: 'none', modeNote: { kind: 'already', mode: 'off' } });
    }
  });

  it('switches mode first, then sets that mode setpoint, and never sets a temperature for Off', () => {
    const toCool = start('cool', 74);
    if (toCool.phase === 'switch-mode') {
      expect(toCool.followup).toEqual({ kind: 'set', targetF: 74 });
      const matched = reduceScheduleApply(toCool, { type: 'mode-result', status: 'done', reached: 'cool' });
      if (matched.phase === 'settled') {
        expect(matched.result).toMatchObject({ status: 'done', step: 'mode', modeNote: { kind: 'switched', mode: 'cool' } });
      }
      const changed = reduceScheduleApply(toCool, { type: 'mode-result', status: 'done', reached: 'cool' });
      expect(changed.phase === 'set-temperature' || (changed.phase === 'settled' && changed.result.status === 'done')).toBe(true);
    }
    const toCoolLower = start('cool', 72);
    if (toCoolLower.phase !== 'switch-mode') {
      throw new Error('expected a mode switch');
    }
    const ready = reduceScheduleApply(toCoolLower, { type: 'mode-result', status: 'done', reached: 'cool' });
    expect(ready.phase).toBe('set-temperature');
    const toOff = start('off', 70);
    if (toOff.phase !== 'switch-mode') {
      throw new Error('expected Off');
    }
    expect(toOff.followup).toEqual({ kind: 'none' });
    const switchedOff = reduceScheduleApply(toOff, { type: 'mode-result', status: 'done', reached: 'off' });
    if (switchedOff.phase === 'settled') {
      expect(switchedOff.result).toMatchObject({ status: 'done', step: 'mode', notifyCheck: false });
    }
  });

  it('stops on a lost, failed, refused, cancelled, or busy mode press and does not continue', () => {
    const switching = start('cool', 72);
    for (const status of ['ambiguous', 'failed', 'refused', 'cancelled', 'busy'] as const) {
      const stopped = reduceScheduleApply(switching, { type: 'mode-result', status, reached: 'heat', reason: status });
      if (stopped.phase !== 'settled') {
        throw new Error(status);
      }
      expect(stopped.result.status).toBe(status);
      expect(stopped.result.step).toBe('mode');
      expect(stopped.result.notifyCheck).toBe(status === 'ambiguous');
    }
    const missed = reduceScheduleApply(switching, { type: 'mode-result', status: 'done', reached: 'heat' });
    if (missed.phase === 'settled') {
      expect(missed.result.status).toBe('failed');
      expect(missed.result.step).toBe('mode');
    }
  });

  it('refuses a mode event while the thermostat mode is unknown', () => {
    const refused = start('heat', 70, unknown);
    if (refused.phase === 'settled') {
      expect(refused.result.status).toBe('refused');
      expect(refused.result.notifyCheck).toBe(false);
      expect(refused.result.reason).toMatch(/unknown/);
    }
  });

  it('ignores events that do not belong to the current phase', () => {
    const idle = idleScheduleApply();
    const modeEvent: ScheduleApplyEvent = { type: 'mode-result', status: 'done', reached: 'cool' };
    const tempEvent: ScheduleApplyEvent = { type: 'temperature-result', status: 'done', stoppedAt: 70, wanted: 70 };
    expect(reduceScheduleApply(idle, modeEvent)).toEqual(idle);
    expect(reduceScheduleApply(idle, tempEvent)).toEqual(idle);
    const switching = start('off', 70);
    expect(reduceScheduleApply(switching, { type: 'start', mode: 'heat', targetF: 70, climate: heat })).toEqual(switching);
    expect(reduceScheduleApply(switching, tempEvent)).toEqual(switching);
    const setting = start(null, 72);
    expect(reduceScheduleApply(setting, modeEvent)).toEqual(setting);
    const finished = reduceScheduleApply(setting, { type: 'temperature-result', status: 'ambiguous', stoppedAt: 70, wanted: 72 });
    if (finished.phase === 'settled') {
      expect(finished.result).toMatchObject({ status: 'ambiguous', notifyCheck: true, step: 'temperature' });
    }
  });

  it('refuses a temperature when the target mode has no setpoint, after the mode switch', () => {
    const bare: ScheduleClimate = { systemMode: 'heat', heatSetpoint: 70, coolSetpoint: null };
    const switching = start('cool', 72, bare);
    const next = reduceScheduleApply(switching, { type: 'mode-result', status: 'done', reached: 'cool' });
    if (next.phase === 'settled') {
      expect(next.result.status).toBe('refused');
      expect(next.result.step).toBe('mode');
      expect(next.result.reason).toMatch(/Cool/);
    }
  });
});

describe('performScheduleApply', () => {
  it('presses mode and then temperature, and skips a press the state does not ask for', async () => {
    const order: string[] = [];
    const switched = await performScheduleApply({
      mode: 'cool',
      targetF: 72,
      climate: heat,
      pressMode: async (mode) => {
        order.push(mode);
        return { status: 'done', reached: mode };
      },
      pressTemperature: async (targetF) => {
        order.push(String(targetF));
        return { status: 'done', stoppedAt: targetF, wanted: targetF };
      },
    });
    expect(order).toEqual(['cool', '72']);
    expect(switched.step).toBe('temperature');
    expect(switched.modeNote).toEqual({ kind: 'switched', mode: 'cool' });

    const already = await performScheduleApply({
      mode: 'heat',
      targetF: 68,
      climate: heat,
      pressMode: async () => {
        throw new Error('mode');
      },
      pressTemperature: async (targetF) => {
        order.push(`temp ${targetF}`);
        return { status: 'done', stoppedAt: targetF, wanted: targetF };
      },
    });
    expect(already.step).toBe('temperature');
    expect(order).toEqual(['cool', '72', 'temp 68']);

    const offRun = await performScheduleApply({
      mode: 'off',
      targetF: 70,
      climate: heat,
      pressMode: async (mode) => ({ status: 'done', reached: mode }),
      pressTemperature: async () => {
        throw new Error('Off does not press a temperature');
      },
    });
    expect(offRun).toMatchObject({ status: 'done', step: 'mode' });
  });

  it('does not press a temperature after a lost mode press, and notifies', async () => {
    let temperatures = 0;
    const lost = await performScheduleApply({
      mode: 'cool',
      targetF: 72,
      climate: heat,
      pressMode: async () => ({ status: 'ambiguous', reached: 'heat', reason: 'The response was lost.' }),
      pressTemperature: async (targetF) => {
        temperatures += 1;
        return { status: 'done', stoppedAt: targetF, wanted: targetF };
      },
    });
    expect(temperatures).toBe(0);
    expect(lost.notifyCheck).toBe(true);
    expect(lost.step).toBe('mode');

    const lostTemp = await performScheduleApply({
      mode: null,
      targetF: 72,
      climate: heat,
      pressMode: async () => {
        throw new Error('no mode');
      },
      pressTemperature: async () => ({ status: 'ambiguous', stoppedAt: 70, wanted: 72, reason: 'The response was lost.' }),
    });
    expect(lostTemp.notifyCheck).toBe(true);
    expect(lostTemp.step).toBe('temperature');
  });

  it('treats an already-in-mode report as a skipped press and still sets the temperature', async () => {
    const temps: number[] = [];
    const result = await performScheduleApply({
      mode: 'cool',
      targetF: 72,
      climate: heat,
      pressMode: async () => ({ status: 'already', reached: 'cool' }),
      pressTemperature: async (targetF) => {
        temps.push(targetF);
        return { status: 'done', stoppedAt: targetF, wanted: targetF };
      },
    });
    expect(temps).toEqual([72]);
    expect(result.modeNote).toEqual({ kind: 'already', mode: 'cool' });
  });
});

describe('schedule apply copy', () => {
  it('keeps the temperature-only sentences and names a mode change', () => {
    const plain = start(null, 70);
    if (plain.phase !== 'settled') {
      throw new Error('expected already');
    }
    expect(alreadyCopy('Wake', 70, plain.result)).toEqual({
      record: 'Already at 70°. No presses sent.',
      log: 'Wake was already at 70°. No presses sent.',
    });
    expect(doneCopy('Wake', 72, { ...plain.result, status: 'done', modeNote: { kind: 'untouched' } })).toBe('Wake set to 72°.');
    const cooling = start('cool', 72);
    const done = reduceScheduleApply(cooling, { type: 'mode-result', status: 'done', reached: 'cool' });
    const settled = reduceScheduleApply(done, { type: 'temperature-result', status: 'done', stoppedAt: 72, wanted: 72 });
    if (settled.phase === 'settled') {
      expect(doneCopy('Wake', 72, settled.result)).toBe('Wake switched to Cool and set 72°.');
    }
    const matched = reduceScheduleApply(start('cool', 74), { type: 'mode-result', status: 'done', reached: 'cool' });
    if (matched.phase === 'settled') {
      expect(doneCopy('Wake', 74, matched.result)).toBe('Wake switched to Cool. Already at 74°. No temperature presses sent.');
    }
    const offSwitch = reduceScheduleApply(start('off', 70), { type: 'mode-result', status: 'done', reached: 'off' });
    if (offSwitch.phase === 'settled') {
      expect(doneCopy('Sleep', 66, offSwitch.result)).toContain('No temperature presses');
      expect(ambiguousCopy('Sleep', { ...offSwitch.result, status: 'ambiguous', step: 'mode' })).toContain('changed mode');
    }
    expect(ambiguousCopy('Wake', plain.result)).toContain('degree was not counted');
    const alreadyOff = start('off', 66, off);
    if (alreadyOff.phase === 'settled') {
      expect(alreadyCopy('Sleep', 66, alreadyOff.result).record).toBe('Already Off. No presses sent.');
    }
    const alreadyHeat = start('heat', 70);
    if (alreadyHeat.phase === 'settled') {
      expect(alreadyCopy('Wake', 70, alreadyHeat.result).record).toContain('Already in Heat');
    }
  });
});
