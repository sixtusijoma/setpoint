import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';

import { runDueSchedule } from '@/domain/scheduleRunner';
import { defaultEvents, nextOccurrence, type RunRecord } from '@/domain/schedule';
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

describe('runDueSchedule', () => {
  it('applies only the latest target and does not press when already there', async () => {
    const calls: number[] = [];
    const already = await runDueSchedule({
      now: at(8, 0),
      events: defaultEvents(),
      records: [],
      hold: null,
      setpoint: 70,
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
      setpoint: 66,
      catchupFrom,
      retryFailed: true,
      execute: async (target) => {
        calls.push(target);
        return { status: 'done', stoppedAt: target, wanted: target };
      },
    });
    expect(calls).toEqual([70]);
    expect(outcome.records.find((record) => record.label === 'Wake')?.status).toBe('ran');
  });

  it('keeps a failed run unrun and records a cancel', async () => {
    const failed = await runDueSchedule({
      now: at(8, 0),
      events: defaultEvents(),
      records: [],
      hold: null,
      setpoint: 66,
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
      setpoint: 68,
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
      setpoint: 66,
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
      setpoint: 67,
      catchupFrom,
      retryFailed: true,
      execute: async () => {
        throw new Error('cancelled runs do not auto retry');
      },
    });
    expect(leftAlone.records.find((item) => item.key === record.key)?.status).toBe('cancelled');
    expect(nextOccurrence(defaultEvents(), at(9, 0))?.label).toBe('Wake');
  });
});
