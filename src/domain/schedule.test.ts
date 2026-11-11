import { readFileSync } from 'node:fs';
import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';

import {
  currentTarget,
  defaultEvents,
  listOccurrences,
  nextOccurrence,
  openCancelled,
  planDue,
  type RunRecord,
} from '@/domain/schedule';
import { TIME_ZONE } from '@/domain/time';

function at(parts: { year: number; month: number; day: number; hour: number; minute: number }): Date {
  return DateTime.fromObject(parts, { zone: TIME_ZONE }).toJSDate();
}

function iso(parts: { year: number; month: number; day: number; hour: number; minute: number }): string {
  return DateTime.fromObject(parts, { zone: TIME_ZONE }).toUTC().toISO() ?? '';
}

describe('schedule clock', () => {
  it('does not read the clock itself', () => {
    const source = readFileSync(new URL('./schedule.ts', import.meta.url), 'utf8');
    expect(source.includes('Date.now')).toBe(false);
  });

  it('places 6:45 AM Eastern on different UTC instants in EST and EDT', () => {
    const winter = DateTime.fromObject(
      { year: 2026, month: 1, day: 15, hour: 6, minute: 45 },
      { zone: TIME_ZONE },
    );
    const summer = DateTime.fromObject(
      { year: 2026, month: 7, day: 15, hour: 6, minute: 45 },
      { zone: TIME_ZONE },
    );
    expect(winter.toUTC().toISO()).toBe('2026-01-15T11:45:00.000Z');
    expect(summer.toUTC().toISO()).toBe('2026-07-15T10:45:00.000Z');
    const winterHits = listOccurrences(
      defaultEvents(),
      winter.minus({ minutes: 1 }),
      winter.plus({ minutes: 1 }),
    );
    const wake = winterHits.find((item) => item.label === 'Wake');
    expect(wake?.at).toBe('2026-01-15T11:45:00.000Z');
  });

  it('keeps Friday night Sleep and gives Saturday only Wake', () => {
    const fridayEvening = at({ year: 2026, month: 11, day: 6, hour: 21, minute: 0 });
    const next = nextOccurrence(defaultEvents(), fridayEvening);
    expect(next?.label).toBe('Sleep');
    expect(next?.targetF).toBe(61);
    const sleepAt = DateTime.fromISO(next?.at ?? '', { setZone: true }).setZone(TIME_ZONE);
    expect(sleepAt.weekday).toBe(5);
    expect(sleepAt.hour).toBe(23);
    expect(sleepAt.minute).toBe(45);

    const fridayLate = at({ year: 2026, month: 11, day: 6, hour: 23, minute: 50 });
    const afterSleep = nextOccurrence(defaultEvents(), fridayLate);
    const wakeAt = DateTime.fromISO(afterSleep?.at ?? '', { setZone: true }).setZone(TIME_ZONE);
    expect(afterSleep?.label).toBe('Wake');
    expect(wakeAt.weekday).toBe(6);
    expect(wakeAt.hour).toBe(6);
    expect(wakeAt.minute).toBe(45);

    const saturday = DateTime.fromObject(
      { year: 2026, month: 11, day: 7, hour: 12, minute: 0 },
      { zone: TIME_ZONE },
    );
    const onSaturday = listOccurrences(defaultEvents(), saturday.startOf('day'), saturday.endOf('day'));
    expect(onSaturday.map((item) => item.label)).toEqual(['Wake']);
  });

  it('marks earlier overdue occurrences missed and applies only the latest', () => {
    const now = at({ year: 2026, month: 11, day: 7, hour: 8, minute: 0 });
    const plan = planDue({
      events: defaultEvents(),
      records: [],
      now,
      hold: null,
      catchupFrom: iso({ year: 2026, month: 11, day: 6, hour: 12, minute: 0 }),
      retryFailed: true,
    });
    expect(plan.missed.map((item) => item.label)).toEqual(['Sleep']);
    expect(plan.apply?.label).toBe('Wake');
    expect(plan.apply?.targetF).toBe(70);
  });

  it('does not replay history from before setup', () => {
    const now = at({ year: 2026, month: 11, day: 7, hour: 20, minute: 0 });
    const plan = planDue({
      events: defaultEvents(),
      records: [],
      now,
      hold: null,
      catchupFrom: iso({ year: 2026, month: 11, day: 7, hour: 19, minute: 0 }),
      retryFailed: true,
    });
    expect(plan.apply).toBeNull();
    expect(plan.missed).toEqual([]);
  });

  it('holds until the next occurrence and then catches up to the latest', () => {
    const during = at({ year: 2026, month: 11, day: 6, hour: 21, minute: 0 });
    const sleep = nextOccurrence(defaultEvents(), during);
    const held = planDue({
      events: defaultEvents(),
      records: [],
      now: during,
      hold: {
        kind: 'until-event',
        eventId: sleep?.eventId ?? 'default-sleep',
        label: 'Sleep',
        occurrenceAt: sleep?.at ?? '',
      },
      catchupFrom: iso({ year: 2026, month: 11, day: 6, hour: 12, minute: 0 }),
      retryFailed: true,
    });
    expect(held.holdActive).toBe(true);
    expect(held.apply).toBeNull();

    const later = planDue({
      events: defaultEvents(),
      records: [],
      now: at({ year: 2026, month: 11, day: 7, hour: 8, minute: 0 }),
      hold: {
        kind: 'until-event',
        eventId: sleep?.eventId ?? 'default-sleep',
        label: 'Sleep',
        occurrenceAt: sleep?.at ?? '',
      },
      catchupFrom: iso({ year: 2026, month: 11, day: 6, hour: 12, minute: 0 }),
      retryFailed: true,
    });
    expect(later.holdExpired).toBe(true);
    expect(later.missed.map((item) => item.label)).toEqual(['Sleep']);
    expect(later.apply?.label).toBe('Wake');
  });

  it('retries a failed run and leaves a cancelled run alone', () => {
    const now = at({ year: 2026, month: 11, day: 7, hour: 8, minute: 0 });
    const wake = currentTarget(defaultEvents(), now);
    expect(wake?.label).toBe('Wake');
    const failed: RunRecord = {
      key: wake?.key ?? '',
      eventId: wake?.eventId ?? '',
      occurrenceAt: wake?.at ?? '',
      label: 'Wake',
      targetF: 70,
      status: 'failed',
      message: 'failed',
      recordedAt: iso({ year: 2026, month: 11, day: 7, hour: 7, minute: 0 }),
    };
    const retry = planDue({
      events: defaultEvents(),
      records: [failed],
      now,
      hold: null,
      catchupFrom: iso({ year: 2026, month: 11, day: 6, hour: 12, minute: 0 }),
      retryFailed: true,
    });
    expect(retry.apply?.key).toBe(wake?.key);
    const waiting = planDue({
      events: defaultEvents(),
      records: [failed],
      now,
      hold: null,
      catchupFrom: iso({ year: 2026, month: 11, day: 6, hour: 12, minute: 0 }),
      retryFailed: false,
    });
    expect(waiting.apply).toBeNull();

    const cancelled = planDue({
      events: defaultEvents(),
      records: [{ ...failed, status: 'cancelled' }],
      now,
      hold: null,
      catchupFrom: iso({ year: 2026, month: 11, day: 6, hour: 12, minute: 0 }),
      retryFailed: true,
    });
    expect(cancelled.apply?.label).not.toBe('Wake');
  });
});

describe('cancelled inbox', () => {
  it('hides a cancelled occurrence once a later one has run', () => {
    const early: RunRecord = {
      key: 'early',
      eventId: 'default-wake',
      occurrenceAt: iso({ year: 2026, month: 11, day: 10, hour: 6, minute: 45 }),
      label: 'Wake',
      targetF: 70,
      status: 'cancelled',
      message: 'Cancelled',
      recordedAt: iso({ year: 2026, month: 11, day: 10, hour: 6, minute: 50 }),
    };
    const later: RunRecord = {
      ...early,
      key: 'later',
      occurrenceAt: iso({ year: 2026, month: 11, day: 10, hour: 23, minute: 45 }),
      label: 'Sleep',
      targetF: 61,
      status: 'done-on-time',
    };
    expect(openCancelled([early]).map((record) => record.key)).toEqual(['early']);
    expect(openCancelled([early, later])).toEqual([]);
  });
});
