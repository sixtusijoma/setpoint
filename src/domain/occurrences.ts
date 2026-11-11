import { DateTime } from 'luxon';

import {
  listOccurrences,
  normalizeStatus,
  occurrenceKey,
  type Occurrence,
  type RunRecord,
  type RunStatus,
  type ScheduleEvent,
} from './schedule';
import { TIME_ZONE } from './time';

export type OccurrencePhase = RunStatus | 'pending';

export type OccurrenceEvent =
  | { type: 'skip' }
  | { type: 'undo-skip' }
  | { type: 'run-now'; when: 'early' | 'late' }
  | { type: 'undo-run-now' }
  | { type: 'on-time' }
  | { type: 'catch-up-apply' }
  | { type: 'catch-up-miss' }
  | { type: 'fail' }
  | { type: 'refuse' }
  | { type: 'cancel' }
  | { type: 'ambiguous' }
  | { type: 'already' }
  | { type: 'retry'; result: 'done-on-time' | 'done-late' | 'already' }
  | { type: 'edit-time' }
  | { type: 'edit-rename' }
  | { type: 'edit-reorder' };

export function transitionOccurrence(
  status: OccurrencePhase,
  event: OccurrenceEvent,
): { status: OccurrencePhase } | { error: string } {
  if (event.type === 'edit-rename' || event.type === 'edit-reorder') {
    return { status };
  }
  if (event.type === 'edit-time') {
    return { status: 'pending' };
  }
  if (event.type === 'skip') {
    if (status !== 'pending') {
      return { error: 'Only a pending occurrence can be skipped.' };
    }
    return { status: 'skipped' };
  }
  if (event.type === 'undo-skip') {
    if (status !== 'skipped') {
      return { error: 'Only a skipped occurrence can be restored.' };
    }
    return { status: 'pending' };
  }
  if (event.type === 'run-now') {
    if (status !== 'pending' && status !== 'skipped' && status !== 'failed' && status !== 'ambiguous') {
      return { error: 'This occurrence is already settled.' };
    }
    return { status: event.when === 'early' ? 'done-early' : 'done-late' };
  }
  if (event.type === 'undo-run-now') {
    if (status !== 'done-early' && status !== 'done-late') {
      return { error: 'Only an early or late run can be undone.' };
    }
    return { status: 'pending' };
  }
  if (event.type === 'on-time' || event.type === 'catch-up-apply' || event.type === 'already') {
    if (status !== 'pending' && status !== 'failed') {
      return { error: 'This occurrence is not waiting to run.' };
    }
    if (event.type === 'on-time') {
      return { status: 'done-on-time' };
    }
    if (event.type === 'already') {
      return { status: 'already' };
    }
    return { status: 'done-late' };
  }
  if (event.type === 'catch-up-miss') {
    if (status !== 'pending' && status !== 'failed') {
      return { error: 'This occurrence cannot be marked missed.' };
    }
    return { status: 'missed' };
  }
  if (event.type === 'fail') {
    if (status !== 'pending' && status !== 'failed') {
      return { error: 'This occurrence cannot fail from here.' };
    }
    return { status: 'failed' };
  }
  if (event.type === 'refuse') {
    if (status !== 'pending' && status !== 'refused') {
      return { error: 'This occurrence cannot be refused from here.' };
    }
    return { status: 'refused' };
  }
  if (event.type === 'cancel') {
    if (status !== 'pending') {
      return { error: 'This occurrence cannot be cancelled from here.' };
    }
    return { status: 'cancelled' };
  }
  if (event.type === 'ambiguous') {
    if (status !== 'pending' && status !== 'failed') {
      return { error: 'This occurrence cannot go ambiguous from here.' };
    }
    return { status: 'ambiguous' };
  }
  if (event.type === 'retry') {
    if (status !== 'failed' && status !== 'ambiguous' && status !== 'pending') {
      return { error: 'This occurrence is not retryable.' };
    }
    return { status: event.result };
  }
  return { error: 'Unknown occurrence event.' };
}

function phaseOf(records: RunRecord[], key: string): OccurrencePhase {
  const record = records.find((item) => item.key === key);
  if (!record) {
    return 'pending';
  }
  return normalizeStatus(record.status) ?? 'pending';
}

export function recordFor(
  records: RunRecord[],
  occurrence: Occurrence,
  status: RunStatus,
  message: string,
  recordedAt: string,
  extra?: Partial<Pick<RunRecord, 'via' | 'previousSetpoint' | 'stepAtFailure'>>,
): RunRecord {
  return {
    key: occurrence.key,
    eventId: occurrence.eventId,
    occurrenceAt: occurrence.at,
    label: occurrence.label,
    targetF: occurrence.targetF,
    status,
    message,
    recordedAt,
    ...extra,
  };
}

export function applyTransition(
  records: RunRecord[],
  occurrence: Occurrence,
  event: OccurrenceEvent,
  recordedAt: string,
  extra?: Partial<Pick<RunRecord, 'via' | 'previousSetpoint' | 'stepAtFailure' | 'message'>>,
): { records: RunRecord[]; status: OccurrencePhase } | { error: string } {
  const current = phaseOf(records, occurrence.key);
  const next = transitionOccurrence(current, event);
  if ('error' in next) {
    return next;
  }
  if (next.status === 'pending') {
    return {
      records: records.filter((item) => item.key !== occurrence.key),
      status: 'pending',
    };
  }
  const message = extra?.message ?? messageFor(occurrence, next.status);
  const record = recordFor(records, occurrence, next.status, message, recordedAt, extra);
  const without = records.filter((item) => item.key !== occurrence.key);
  return { records: [...without, record].slice(-400), status: next.status };
}

function messageFor(occurrence: Occurrence, status: RunStatus): string {
  if (status === 'skipped') {
    return `Skipped ${occurrence.label} · ${occurrence.targetF}°.`;
  }
  if (status === 'done-early') {
    return `${occurrence.label} ran early at ${occurrence.targetF}°.`;
  }
  if (status === 'done-late') {
    return `${occurrence.label} ran late at ${occurrence.targetF}°.`;
  }
  if (status === 'done-on-time') {
    return `${occurrence.label} ran on time at ${occurrence.targetF}°.`;
  }
  if (status === 'missed') {
    return `Missed ${occurrence.label}. A later change took its place.`;
  }
  return `${occurrence.label} is ${status}.`;
}

function instant(now: Date): DateTime {
  return DateTime.fromJSDate(now).setZone(TIME_ZONE);
}

export function upcomingForEvent(events: ScheduleEvent[], eventId: string, now: Date, days = 21): Occurrence[] {
  const nowDt = instant(now);
  return listOccurrences(
    events.filter((event) => event.id === eventId),
    nowDt.plus({ milliseconds: 1 }),
    nowDt.plus({ days }),
  );
}

export function occurrenceOnDate(events: ScheduleEvent[], eventId: string, day: string): Occurrence | null {
  const date = DateTime.fromISO(day, { zone: TIME_ZONE });
  if (!date.isValid) {
    return null;
  }
  const matches = listOccurrences(
    events.filter((event) => event.id === eventId),
    date.startOf('day'),
    date.endOf('day'),
  );
  return matches[0] ?? null;
}

export function nextSkippable(events: ScheduleEvent[], records: RunRecord[], eventId: string, now: Date): Occurrence | null {
  const upcoming = upcomingForEvent(events, eventId, now);
  for (const item of upcoming) {
    if (phaseOf(records, item.key) === 'pending') {
      return item;
    }
  }
  return null;
}

export function occurrenceForRunNow(
  events: ScheduleEvent[],
  eventId: string,
  now: Date,
): Occurrence | null {
  const nowDt = instant(now);
  const today = listOccurrences(
    events.filter((event) => event.id === eventId),
    nowDt.startOf('day'),
    nowDt.endOf('day'),
  );
  if (today[0]) {
    return today[0];
  }
  return upcomingForEvent(events, eventId, now, 8)[0] ?? null;
}

export function localDateKey(now: Date): string {
  return instant(now).toFormat('yyyy-LL-dd');
}

export function occurrenceIdentity(eventId: string, atIso: string): string {
  return occurrenceKey(eventId, atIso);
}
