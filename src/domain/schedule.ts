import { DateTime } from 'luxon';

import { TIME_ZONE } from './time';

export type ScheduleEvent = {
  id: string;
  label: string;
  hour: number;
  minute: number;
  targetF: number;
  days: number[];
  enabled: boolean;
};

export type Occurrence = {
  key: string;
  eventId: string;
  label: string;
  targetF: number;
  at: string;
};

export type RunStatus =
  | 'skipped'
  | 'done-early'
  | 'done-on-time'
  | 'done-late'
  | 'missed'
  | 'failed'
  | 'cancelled'
  | 'refused'
  | 'ambiguous'
  | 'already';

export type RunVia = 'scheduler' | 'catch-up' | 'run-now' | 'apply-now' | 'retry';

export type RunRecord = {
  key: string;
  eventId: string;
  occurrenceAt: string;
  label: string;
  targetF: number;
  status: RunStatus;
  message: string;
  recordedAt: string;
  via?: RunVia;
  previousSetpoint?: number;
  stepAtFailure?: number;
};

export type HoldState =
  | null
  | { kind: 'until-event'; eventId: string; label: string; occurrenceAt: string }
  | { kind: 'until-resume' };

export type DuePlan = {
  holdActive: boolean;
  holdExpired: boolean;
  holdNext: HoldState;
  missed: Occurrence[];
  apply: Occurrence | null;
};

const RUN_STATUSES: RunStatus[] = [
  'skipped',
  'done-early',
  'done-on-time',
  'done-late',
  'missed',
  'failed',
  'cancelled',
  'refused',
  'ambiguous',
  'already',
];

export function normalizeStatus(status: string): RunStatus | null {
  if (status === 'ran') {
    return 'done-on-time';
  }
  if (RUN_STATUSES.includes(status as RunStatus)) {
    return status as RunStatus;
  }
  return null;
}

export function isDoneStatus(status: RunStatus): boolean {
  return status === 'done-early' || status === 'done-on-time' || status === 'done-late' || status === 'already';
}

const LOOKBACK_DAYS = 8;

export function defaultEvents(): ScheduleEvent[] {
  return [
    {
      id: 'default-sleep',
      label: 'Sleep',
      hour: 23,
      minute: 45,
      targetF: 61,
      days: [1, 2, 3, 4, 5],
      enabled: true,
    },
    {
      id: 'default-wake',
      label: 'Wake',
      hour: 6,
      minute: 45,
      targetF: 70,
      days: [1, 2, 3, 4, 5, 6, 7],
      enabled: true,
    },
  ];
}

export function occurrenceKey(eventId: string, atIso: string): string {
  const millis = DateTime.fromISO(atIso, { setZone: true }).toUTC().toMillis();
  return `${eventId}@${millis}`;
}

function toOccurrence(event: ScheduleEvent, at: DateTime): Occurrence {
  const iso = at.toUTC().toISO() ?? at.toISO() ?? '';
  return {
    key: occurrenceKey(event.id, iso),
    eventId: event.id,
    label: event.label,
    targetF: event.targetF,
    at: iso,
  };
}

export function listOccurrences(events: ScheduleEvent[], start: DateTime, end: DateTime): Occurrence[] {
  const results: Occurrence[] = [];
  let day = start.setZone(TIME_ZONE).startOf('day');
  const lastDay = end.setZone(TIME_ZONE).startOf('day');
  while (day <= lastDay) {
    for (const event of events) {
      if (!event.enabled) {
        continue;
      }
      if (!event.days.includes(day.weekday)) {
        continue;
      }
      const at = day.set({
        hour: event.hour,
        minute: event.minute,
        second: 0,
        millisecond: 0,
      });
      if (at < start || at > end) {
        continue;
      }
      results.push(toOccurrence(event, at));
    }
    day = day.plus({ days: 1 });
  }
  results.sort((a, b) => {
    return DateTime.fromISO(a.at, { setZone: true }).toMillis() - DateTime.fromISO(b.at, { setZone: true }).toMillis();
  });
  return results;
}

function instant(now: Date): DateTime {
  return DateTime.fromJSDate(now).setZone(TIME_ZONE);
}

export function nextOccurrence(events: ScheduleEvent[], now: Date): Occurrence | null {
  const nowDt = instant(now);
  const upcoming = listOccurrences(events, nowDt.plus({ milliseconds: 1 }), nowDt.plus({ days: 8 }));
  if (upcoming.length === 0) {
    return null;
  }
  return upcoming[0];
}

export function nextOccurrenceOfEvent(events: ScheduleEvent[], eventId: string, now: Date): Occurrence | null {
  return nextOccurrence(
    events.filter((event) => event.id === eventId),
    now,
  );
}

export function holdFor(events: ScheduleEvent[], now: Date): HoldState {
  const next = nextOccurrence(events, now);
  if (!next) {
    return { kind: 'until-resume' };
  }
  return { kind: 'until-event', eventId: next.eventId, label: next.label, occurrenceAt: next.at };
}

export function resolveHold(
  hold: HoldState,
  events: ScheduleEvent[],
  now: Date,
): { active: boolean; expired: boolean; next: HoldState; deadline: Occurrence | null } {
  if (!hold) {
    return { active: false, expired: false, next: null, deadline: null };
  }
  if (hold.kind === 'until-resume') {
    const upcoming = nextOccurrence(events, now);
    if (!upcoming) {
      return { active: true, expired: false, next: hold, deadline: null };
    }
    return {
      active: true,
      expired: false,
      next: { kind: 'until-event', eventId: upcoming.eventId, label: upcoming.label, occurrenceAt: upcoming.at },
      deadline: upcoming,
    };
  }
  const event = events.find((item) => item.id === hold.eventId && item.enabled);
  let occurrenceAt = hold.occurrenceAt;
  let label = hold.label;
  if (event) {
    const stored = DateTime.fromISO(hold.occurrenceAt, { setZone: true }).setZone(TIME_ZONE);
    if (stored.isValid && event.days.includes(stored.weekday)) {
      const shifted = stored.set({
        hour: event.hour,
        minute: event.minute,
        second: 0,
        millisecond: 0,
      });
      occurrenceAt = shifted.toUTC().toISO() ?? occurrenceAt;
      label = event.label;
    }
  }
  const deadlineAt = DateTime.fromISO(occurrenceAt, { setZone: true });
  const nowDt = instant(now);
  if (deadlineAt.isValid && deadlineAt > nowDt) {
    const deadline = event
      ? {
          key: occurrenceKey(event.id, occurrenceAt),
          eventId: event.id,
          label,
          targetF: event.targetF,
          at: occurrenceAt,
        }
      : {
          key: occurrenceKey(hold.eventId, occurrenceAt),
          eventId: hold.eventId,
          label,
          targetF: 0,
          at: occurrenceAt,
        };
    return {
      active: true,
      expired: false,
      next: { kind: 'until-event', eventId: hold.eventId, label, occurrenceAt },
      deadline,
    };
  }
  return { active: false, expired: true, next: null, deadline: null };
}

export function upcomingOccurrences(events: ScheduleEvent[], now: Date, days: number): Occurrence[] {
  const nowDt = instant(now);
  return listOccurrences(events, nowDt.plus({ milliseconds: 1 }), nowDt.plus({ days }));
}

export function currentTarget(events: ScheduleEvent[], now: Date): Occurrence | null {
  const nowDt = instant(now);
  const items = listOccurrences(events, nowDt.minus({ days: LOOKBACK_DAYS }), nowDt);
  if (items.length === 0) {
    return null;
  }
  return items[items.length - 1];
}

function isOpen(item: Occurrence, record: RunRecord | undefined, retryFailed: boolean, step: number | undefined): boolean {
  if (!record) {
    return true;
  }
  const status = normalizeStatus(record.status);
  if (!status) {
    return true;
  }
  if (status === 'failed') {
    return true;
  }
  if (status === 'refused') {
    if (record.targetF !== item.targetF) {
      return true;
    }
    if (step !== undefined && record.stepAtFailure !== undefined && record.stepAtFailure !== step) {
      return true;
    }
    return false;
  }
  return false;
}

export function planDue(input: {
  events: ScheduleEvent[];
  records: RunRecord[];
  now: Date;
  hold: HoldState;
  catchupFrom: string | null;
  retryFailed: boolean;
  step?: number;
}): DuePlan {
  const resolved = resolveHold(input.hold, input.events, input.now);
  if (resolved.active) {
    return { holdActive: true, holdExpired: false, holdNext: resolved.next, missed: [], apply: null };
  }
  const holdExpired = Boolean(input.hold);
  if (!input.catchupFrom) {
    return { holdActive: false, holdExpired, holdNext: null, missed: [], apply: null };
  }
  const nowDt = instant(input.now);
  const catchup = DateTime.fromISO(input.catchupFrom, { setZone: true });
  const windowStart = nowDt.minus({ days: LOOKBACK_DAYS });
  const start = catchup > windowStart ? catchup : windowStart;
  const due = listOccurrences(input.events, start.plus({ milliseconds: 1 }), nowDt);
  const byKey = new Map(input.records.map((record) => [record.key, record]));
  const open = due.filter((item) => isOpen(item, byKey.get(item.key), input.retryFailed, input.step));
  if (open.length === 0) {
    return { holdActive: false, holdExpired, holdNext: null, missed: [], apply: null };
  }
  const latest = open[open.length - 1];
  const missed = open.slice(0, -1);
  const latestRecord = byKey.get(latest.key);
  const latestStatus = latestRecord ? normalizeStatus(latestRecord.status) : null;
  if (latestStatus === 'failed' && !input.retryFailed && latestRecord?.targetF === latest.targetF) {
    return { holdActive: false, holdExpired, holdNext: null, missed, apply: null };
  }
  return { holdActive: false, holdExpired, holdNext: null, missed, apply: latest };
}

export function upsertRecord(records: RunRecord[], record: RunRecord): RunRecord[] {
  const next = records.filter((item) => item.key !== record.key);
  next.push(record);
  if (next.length > 400) {
    return next.slice(next.length - 400);
  }
  return next;
}

const SUPERSEDES_CANCEL = new Set<RunStatus>(['done-early', 'done-on-time', 'done-late', 'already', 'missed']);

export function openCancelled(records: RunRecord[]): RunRecord[] {
  return records.filter((record) => {
    if (normalizeStatus(record.status) !== 'cancelled') {
      return false;
    }
    const superseded = records.some((other) => {
      if (other.key === record.key) {
        return false;
      }
      const status = normalizeStatus(other.status);
      if (!status || !SUPERSEDES_CANCEL.has(status)) {
        return false;
      }
      return other.occurrenceAt > record.occurrenceAt;
    });
    return !superseded;
  });
}

export function latestRecord(records: RunRecord[], statuses: RunStatus[]): RunRecord | null {
  let best: RunRecord | null = null;
  for (const record of records) {
    if (!statuses.includes(record.status)) {
      continue;
    }
    if (!best || record.recordedAt > best.recordedAt) {
      best = record;
    }
  }
  return best;
}

export function holdCopy(setpoint: number, hold: HoldState, events: ScheduleEvent[], now: Date): string {
  if (!hold) {
    return 'Following schedule';
  }
  const resolved = resolveHold(hold, events, now);
  if (!resolved.deadline) {
    return `Holding ${setpoint}°. Nothing is scheduled next.`;
  }
  return `Holding ${setpoint}° until ${resolved.deadline.label} · ${formatHoldTime(resolved.deadline.at)}. Only the latest due change runs after that.`;
}

export type ChipState =
  | { kind: 'holding'; text: string }
  | { kind: 'following'; text: string }
  | { kind: 'off-schedule'; text: string; targetF: number; label: string; eventId: string };

export function intendedTarget(events: ScheduleEvent[], records: RunRecord[], now: Date): Occurrence | null {
  const nowDt = instant(now);
  const items = listOccurrences(events, nowDt.minus({ days: LOOKBACK_DAYS }), nowDt);
  const skipped = new Set(
    records
      .filter((record) => normalizeStatus(record.status) === 'skipped')
      .map((record) => record.key),
  );
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (!skipped.has(items[index].key)) {
      return items[index];
    }
  }
  return null;
}

export function chipFor(input: {
  setpoint: number;
  hold: HoldState;
  events: ScheduleEvent[];
  records: RunRecord[];
  now: Date;
}): ChipState {
  if (input.hold) {
    return { kind: 'holding', text: holdCopy(input.setpoint, input.hold, input.events, input.now) };
  }
  const intended = intendedTarget(input.events, input.records, input.now);
  if (!intended || intended.targetF === input.setpoint) {
    return { kind: 'following', text: 'Following schedule' };
  }
  return {
    kind: 'off-schedule',
    text: `Off schedule. ${intended.label} is ${intended.targetF}°. Tap to retry.`,
    targetF: intended.targetF,
    label: intended.label,
    eventId: intended.eventId,
  };
}

export function catchupSentence(missed: { label: string }[], appliedLabel: string): string {
  const names = missed.map((item) => item.label);
  let missedText = names[0] ?? 'An earlier change';
  if (names.length === 2) {
    missedText = `${names[0]} and ${names[1]}`;
  } else if (names.length > 2) {
    missedText = `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
  }
  const verb = names.length > 1 ? 'were' : 'was';
  return `${missedText} ${verb} missed, applied ${appliedLabel}.`;
}

export function scheduleEditResetsCursor(before: ScheduleEvent, after: ScheduleEvent): boolean {
  if (before.hour !== after.hour || before.minute !== after.minute) {
    return true;
  }
  if (before.targetF !== after.targetF) {
    return true;
  }
  return false;
}

export function defaultsResetCursor(current: ScheduleEvent[], defaults: ScheduleEvent[]): boolean {
  if (current.length !== defaults.length) {
    return true;
  }
  for (const next of defaults) {
    const prev = current.find((item) => item.id === next.id);
    if (!prev) {
      return true;
    }
    if (scheduleEditResetsCursor(prev, next)) {
      return true;
    }
  }
  return false;
}

export function completionStatus(atIso: string, now: Date, via: RunVia): 'done-early' | 'done-on-time' | 'done-late' {
  const at = DateTime.fromISO(atIso, { setZone: true });
  const nowDt = DateTime.fromJSDate(now).setZone(TIME_ZONE);
  if (!at.isValid) {
    return via === 'run-now' ? 'done-early' : 'done-on-time';
  }
  if (via === 'run-now') {
    if (nowDt < at) {
      return 'done-early';
    }
    return 'done-late';
  }
  if (nowDt < at.minus({ minutes: 1 })) {
    return 'done-early';
  }
  if (nowDt > at.plus({ minutes: 5 })) {
    return 'done-late';
  }
  return 'done-on-time';
}

function formatHoldTime(iso: string): string {
  const instantAt = DateTime.fromISO(iso, { setZone: true }).setZone(TIME_ZONE);
  if (!instantAt.isValid) {
    return '';
  }
  return instantAt.toFormat('h:mm a');
}
