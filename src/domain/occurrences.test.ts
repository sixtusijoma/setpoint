import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';

import {
  applyTransition,
  nextSkippable,
  occurrenceForRunNow,
  occurrenceOnDate,
  transitionOccurrence,
} from '@/domain/occurrences';
import {
  catchupSentence,
  chipFor,
  defaultEvents,
  holdFor,
  planDue,
  resolveHold,
  scheduleEditResetsCursor,
  type ScheduleEvent,
} from '@/domain/schedule';
import { TIME_ZONE } from '@/domain/time';

function at(parts: { year: number; month: number; day: number; hour: number; minute: number }): Date {
  return DateTime.fromObject(parts, { zone: TIME_ZONE }).toJSDate();
}

describe('occurrence state machine', () => {
  it('skips and undoes a pending occurrence', () => {
    expect(transitionOccurrence('pending', { type: 'skip' })).toEqual({ status: 'skipped' });
    expect(transitionOccurrence('skipped', { type: 'undo-skip' })).toEqual({ status: 'pending' });
    expect(transitionOccurrence('pending', { type: 'undo-skip' })).toEqual({
      error: 'Only a skipped occurrence can be restored.',
    });
    expect(transitionOccurrence('done-on-time', { type: 'skip' })).toEqual({
      error: 'Only a pending occurrence can be skipped.',
    });
  });

  it('runs now from pending or skipped, early or late, and undoes it', () => {
    expect(transitionOccurrence('pending', { type: 'run-now', when: 'early' })).toEqual({ status: 'done-early' });
    expect(transitionOccurrence('pending', { type: 'run-now', when: 'late' })).toEqual({ status: 'done-late' });
    expect(transitionOccurrence('skipped', { type: 'run-now', when: 'late' })).toEqual({ status: 'done-late' });
    expect(transitionOccurrence('done-early', { type: 'undo-run-now' })).toEqual({ status: 'pending' });
    expect(transitionOccurrence('done-late', { type: 'undo-run-now' })).toEqual({ status: 'pending' });
    expect(transitionOccurrence('done-on-time', { type: 'undo-run-now' })).toEqual({
      error: 'Only an early or late run can be undone.',
    });
  });

  it('covers scheduler, catch-up, failure, and refusal transitions', () => {
    expect(transitionOccurrence('pending', { type: 'on-time' })).toEqual({ status: 'done-on-time' });
    expect(transitionOccurrence('pending', { type: 'catch-up-apply' })).toEqual({ status: 'done-late' });
    expect(transitionOccurrence('pending', { type: 'catch-up-miss' })).toEqual({ status: 'missed' });
    expect(transitionOccurrence('failed', { type: 'catch-up-miss' })).toEqual({ status: 'missed' });
    expect(transitionOccurrence('pending', { type: 'fail' })).toEqual({ status: 'failed' });
    expect(transitionOccurrence('failed', { type: 'retry', result: 'done-late' })).toEqual({ status: 'done-late' });
    expect(transitionOccurrence('pending', { type: 'refuse' })).toEqual({ status: 'refused' });
    expect(transitionOccurrence('pending', { type: 'cancel' })).toEqual({ status: 'cancelled' });
    expect(transitionOccurrence('pending', { type: 'ambiguous' })).toEqual({ status: 'ambiguous' });
    expect(transitionOccurrence('pending', { type: 'already' })).toEqual({ status: 'already' });
    expect(transitionOccurrence('missed', { type: 'on-time' })).toEqual({
      error: 'This occurrence is not waiting to run.',
    });
    expect(transitionOccurrence('ambiguous', { type: 'catch-up-apply' })).toEqual({
      error: 'This occurrence is not waiting to run.',
    });
  });

  it('leaves a rename or reorder in place and reopens a time edit', () => {
    expect(transitionOccurrence('done-on-time', { type: 'edit-rename' })).toEqual({ status: 'done-on-time' });
    expect(transitionOccurrence('skipped', { type: 'edit-reorder' })).toEqual({ status: 'skipped' });
    expect(transitionOccurrence('done-early', { type: 'edit-time' })).toEqual({ status: 'pending' });
    expect(transitionOccurrence('pending', { type: 'edit-time' })).toEqual({ status: 'pending' });
  });

  it('stores a skip and removes it on undo', () => {
    const now = at({ year: 2026, month: 11, day: 9, hour: 12, minute: 0 });
    const wake = nextSkippable(defaultEvents(), [], 'default-wake', now);
    expect(wake?.label).toBe('Wake');
    if (!wake) {
      return;
    }
    const skipped = applyTransition([], wake, { type: 'skip' }, now.toISOString());
    if ('error' in skipped) {
      throw new Error(skipped.error);
    }
    expect(skipped.status).toBe('skipped');
    const restored = applyTransition(skipped.records, wake, { type: 'undo-skip' }, now.toISOString());
    if ('error' in restored) {
      throw new Error(restored.error);
    }
    expect(restored.records).toEqual([]);
    const chosen = occurrenceOnDate(defaultEvents(), 'default-wake', '2026-11-10');
    expect(chosen?.label).toBe('Wake');
  });

  it('selects today for run now, including a skipped wake', () => {
    const morning = at({ year: 2026, month: 11, day: 9, hour: 8, minute: 0 });
    const today = occurrenceForRunNow(defaultEvents(), 'default-wake', morning);
    expect(today?.label).toBe('Wake');
    const evening = at({ year: 2026, month: 11, day: 9, hour: 21, minute: 0 });
    const sleep = occurrenceForRunNow(defaultEvents(), 'default-sleep', evening);
    expect(sleep?.label).toBe('Sleep');
    expect(DateTime.fromISO(sleep?.at ?? '', { setZone: true }).setZone(TIME_ZONE).hour).toBe(23);
  });
});

describe('schedule edits, chip, and catch-up copy', () => {
  it('resets the cursor only for time or temperature edits', () => {
    const [sleep] = defaultEvents();
    expect(scheduleEditResetsCursor(sleep, { ...sleep, label: 'Bedtime' })).toBe(false);
    expect(scheduleEditResetsCursor(sleep, { ...sleep, days: [1, 2, 3, 4, 5, 6] })).toBe(false);
    expect(scheduleEditResetsCursor(sleep, { ...sleep, minute: 50 })).toBe(true);
    expect(scheduleEditResetsCursor(sleep, { ...sleep, targetF: 62 })).toBe(true);
  });

  it('moves a hold deadline when the event time changes', () => {
    const now = at({ year: 2026, month: 11, day: 6, hour: 21, minute: 0 });
    const hold = holdFor(defaultEvents(), now);
    expect(hold?.kind).toBe('until-event');
    if (hold?.kind !== 'until-event') {
      return;
    }
    const moved: ScheduleEvent[] = defaultEvents().map((event) => {
      if (event.id !== hold.eventId) {
        return event;
      }
      return { ...event, hour: 20, minute: 15 };
    });
    const resolved = resolveHold(hold, moved, now);
    expect(resolved.active).toBe(false);
    const earlierNow = at({ year: 2026, month: 11, day: 6, hour: 19, minute: 0 });
    const still = resolveHold(hold, moved, earlierNow);
    expect(still.active).toBe(true);
    const deadline = DateTime.fromISO(still.deadline?.at ?? '', { setZone: true }).setZone(TIME_ZONE);
    expect(deadline.hour).toBe(20);
    expect(deadline.minute).toBe(15);
  });

  it('shows off schedule when the setpoint does not match the current target', () => {
    const now = at({ year: 2026, month: 11, day: 7, hour: 8, minute: 0 });
    const following = chipFor({
      setpoint: 70,
      hold: null,
      events: defaultEvents(),
      records: [],
      now,
    });
    expect(following.kind).toBe('following');
    const off = chipFor({
      setpoint: 66,
      hold: null,
      events: defaultEvents(),
      records: [],
      now,
    });
    expect(off.kind).toBe('off-schedule');
    if (off.kind !== 'off-schedule') {
      return;
    }
    expect(off.label).toBe('Wake');
    expect(off.targetF).toBe(70);
    expect(off.text).toContain('Tap to retry');
  });

  it('names the missed change and the one that was applied', () => {
    expect(catchupSentence([{ label: 'Sleep' }], 'Wake')).toBe('Sleep was missed, applied Wake.');
    const now = at({ year: 2026, month: 11, day: 7, hour: 8, minute: 0 });
    const plan = planDue({
      events: defaultEvents(),
      records: [],
      now,
      hold: null,
      catchupFrom: DateTime.fromObject(
        { year: 2026, month: 11, day: 6, hour: 12, minute: 0 },
        { zone: TIME_ZONE },
      ).toUTC().toISO(),
      retryFailed: true,
    });
    expect(catchupSentence(plan.missed, plan.apply?.label ?? '')).toBe('Sleep was missed, applied Wake.');
  });
});
