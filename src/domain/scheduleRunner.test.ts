import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';

import type { ScheduleClimate } from '@/domain/scheduleApply';
import { runDueSchedule } from '@/domain/scheduleRunner';
import { defaultEvents, nextOccurrence, type RunRecord, type ScheduleEvent } from '@/domain/schedule';
import { TIME_ZONE } from '@/domain/time';

function at(hour: number, minute: number, day = 7): Date {
  return DateTime.fromObject(
    { year: 2026, month: 11, day, hour, minute },
    { zone: TIME_ZONE },
  ).toJSDate();
}

const catchupFrom =
  DateTime.fromObject(
    { year: 2026, month: 11, day: 6, hour: 12, minute: 0 },
    { zone: TIME_ZONE },
  ).toUTC().toISO() ?? '';

function climate(setpoint: number, systemMode: ScheduleClimate['systemMode'] = 'heat'): ScheduleClimate {
  return { systemMode, heatSetpoint: setpoint, coolSetpoint: setpoint };
}

const noMode = async () => {
  throw new Error('no mode press');
};

describe('runDueSchedule', () => {
  it('applies only the latest target and does not press when already there', async () => {
    const calls: number[] = [];
    const already = await runDueSchedule({
      now: at(8, 0),
      events: defaultEvents(),
      records: [],
      hold: null,
      climate: climate(70),
      pressMode: noMode,
      catchupFrom,
      retryFailed: true,
      execute: async (target) => {
        calls.push(target);
        return { status: 'done', stoppedAt: target, wanted: target };
      },
    });
    expect(calls).toEqual([]);
    expect(already.records.some((record) => record.status === 'already' && record.label === 'Wake')).toBe(true);
    expect(already.records.some((record) => record.status === 'missed' && record.label === 'Sleep')).toBe(true);
    expect(already.log.some((line) => line.message.includes('No presses sent'))).toBe(true);
  });

  it('calls the executor once for the latest target', async () => {
    const calls: number[] = [];
    const outcome = await runDueSchedule({
      now: at(8, 0),
      events: defaultEvents(),
      records: [],
      hold: null,
      climate: climate(66),
      pressMode: noMode,
      catchupFrom,
      retryFailed: true,
      execute: async (target) => {
        calls.push(target);
        return { status: 'done', stoppedAt: target, wanted: target };
      },
    });
    expect(calls).toEqual([70]);
    expect(outcome.records.find((record) => record.label === 'Wake')?.status).toBe('done-late');
  });

  it('keeps a failed run unrun and records a cancel', async () => {
    const failed = await runDueSchedule({
      now: at(8, 0),
      events: defaultEvents(),
      records: [],
      hold: null,
      climate: climate(66),
      pressMode: noMode,
      catchupFrom,
      retryFailed: true,
      execute: async () => ({ status: 'failed', stoppedAt: 68, wanted: 70 }),
    });
    const wake = failed.records.find((record) => record.label === 'Wake');
    expect(wake?.status).toBe('failed');
    expect(failed.log.some((line) => line.message.includes('Stopped at 68°'))).toBe(true);

    const again = await runDueSchedule({
      now: at(8, 5),
      events: defaultEvents(),
      records: failed.records,
      hold: null,
      climate: climate(68),
      pressMode: noMode,
      catchupFrom,
      retryFailed: false,
      execute: async () => {
        throw new Error('should not retry yet');
      },
    });
    expect(again.records.find((record) => record.label === 'Wake')?.status).toBe('failed');

    const cancelled = await runDueSchedule({
      now: at(8, 0),
      events: defaultEvents(),
      records: [],
      hold: null,
      climate: climate(66),
      pressMode: noMode,
      catchupFrom,
      retryFailed: true,
      execute: async () => ({ status: 'cancelled', stoppedAt: 67, wanted: 70 }),
    });
    const record = cancelled.records.find((item) => item.label === 'Wake') as RunRecord;
    expect(record.status).toBe('cancelled');
    const leftAlone = await runDueSchedule({
      now: at(9, 0),
      events: defaultEvents(),
      records: cancelled.records,
      hold: null,
      climate: climate(67),
      pressMode: noMode,
      catchupFrom,
      retryFailed: true,
      execute: async () => {
        throw new Error('cancelled runs do not auto retry');
      },
    });
    expect(leftAlone.records.find((item) => item.key === record.key)?.status).toBe('cancelled');
    expect(nextOccurrence(defaultEvents(), at(9, 0))?.label).toBe('Sleep');
  });

  it('switches mode before temperature and skips the mode press when already there', async () => {
    const wake: ScheduleEvent = { ...defaultEvents()[1], mode: 'cool', targetF: 74 };
    const modes: string[] = [];
    const temps: number[] = [];
    const switched = await runDueSchedule({
      now: at(8, 0),
      events: [wake],
      records: [],
      hold: null,
      climate: { systemMode: 'heat', heatSetpoint: 70, coolSetpoint: 72 },
      catchupFrom,
      retryFailed: true,
      pressMode: async (mode) => {
        modes.push(mode);
        return { status: 'done', reached: mode };
      },
      execute: async (target) => {
        temps.push(target);
        return { status: 'done', stoppedAt: target, wanted: target };
      },
    });
    expect(modes).toEqual(['cool']);
    expect(temps).toEqual([74]);
    expect(switched.records.find((record) => record.label === 'Wake')?.message).toContain('Cool');
    expect(switched.notifyCheck).toBe(false);

    const alreadyThere = await runDueSchedule({
      now: at(8, 0),
      events: [{ ...wake, mode: 'heat', targetF: 70 }],
      records: [],
      hold: null,
      climate: climate(70),
      catchupFrom,
      retryFailed: true,
      pressMode: async () => {
        throw new Error('already in Heat');
      },
      execute: async () => {
        throw new Error('already at 70');
      },
    });
    expect(alreadyThere.records.find((record) => record.status === 'already')?.message).toContain('Already in Heat');
  });

  it('does not press a temperature for Off, and a lost mode press stops the run', async () => {
    const offEvent: ScheduleEvent = { ...defaultEvents()[1], mode: 'off' };
    const temps: number[] = [];
    const off = await runDueSchedule({
      now: at(8, 0),
      events: [offEvent],
      records: [],
      hold: null,
      climate: climate(70),
      catchupFrom,
      retryFailed: true,
      pressMode: async (mode) => ({ status: 'done', reached: mode }),
      execute: async (target) => {
        temps.push(target);
        return { status: 'done', stoppedAt: target, wanted: target };
      },
    });
    expect(temps).toEqual([]);
    expect(off.records.find((record) => record.label === 'Wake')?.message).toContain('No temperature presses');
    expect(off.schedulePhase).toBe('armed');

    const lost = await runDueSchedule({
      now: at(8, 0),
      events: [offEvent],
      records: [],
      hold: null,
      climate: climate(70),
      catchupFrom,
      retryFailed: true,
      pressMode: async () => ({ status: 'ambiguous', reached: 'heat', reason: 'The response was lost.' }),
      execute: async () => {
        throw new Error('temperature waits behind the mode press');
      },
    });
    expect(lost.notifyCheck).toBe(true);
    expect(lost.schedulePhase).toBe('armed');
    expect(lost.records.find((record) => record.status === 'ambiguous')?.message).toContain('Later schedules still run');
  });

  it('does not record a busy mode press, and records a refusal', async () => {
    const busy = await runDueSchedule({
      now: at(8, 0),
      events: [{ ...defaultEvents()[1], mode: 'cool' }],
      records: [],
      hold: null,
      climate: climate(70),
      catchupFrom,
      retryFailed: true,
      pressMode: async () => ({ status: 'busy', reached: 'heat', reason: 'A command is already running.' }),
      execute: async () => {
        throw new Error('busy waits');
      },
    });
    expect(busy.records).toEqual([]);
    expect(busy.notifyCheck).toBe(false);
    expect(busy.log).toEqual([]);

    const refused = await runDueSchedule({
      now: at(8, 0),
      events: [defaultEvents()[1]],
      records: [],
      hold: null,
      climate: { systemMode: 'off', heatSetpoint: 70, coolSetpoint: 74 },
      catchupFrom,
      retryFailed: true,
      pressMode: noMode,
      execute: async () => {
        throw new Error('Off has no temperature');
      },
    });
    expect(refused.records.find((record) => record.status === 'refused')?.message).toContain('Off');
    expect(refused.notifyCheck).toBe(false);
    expect(refused.schedulePhase).toBe('armed');

    const unnamed = await runDueSchedule({
      now: at(8, 0),
      events: [{ ...defaultEvents()[1], mode: 'cool' }],
      records: [],
      hold: null,
      climate: climate(70),
      catchupFrom,
      retryFailed: true,
      pressMode: async () => ({ status: 'refused', reached: 'heat' }),
      execute: async () => {
        throw new Error('refused mode does not set a temperature');
      },
    });
    expect(unnamed.records.find((record) => record.status === 'refused')?.message).toContain('No presses sent');
  });
});
