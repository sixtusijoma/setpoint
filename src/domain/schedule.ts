import { DateTime } from 'luxon';

import { TIME_ZONE } from '@/domain/time';

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

export type RunStatus = 'ran' | 'already' | 'missed' | 'failed' | 'cancelled';

export type RunRecord = {
  key: string;
  eventId: string;
  occurrenceAt: string;
  label: string;
  targetF: number;
  status: RunStatus;
  message: string;
  recordedAt: string;
};

export type HoldState = {
  until: string | null;
  label: string;
} | null;

export type DuePlan = {
  holdActive: boolean;
  holdExpired: boolean;
  missed: Occurrence[];
  apply: Occurrence | null;
};

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

function statusByKey(records: RunRecord[]): Map<string, RunStatus> {
  const map = new Map<string, RunStatus>();
  for (const record of records) {
    map.set(record.key, record.status);
  }
  return map;
}

export function planDue(input: {
  events: ScheduleEvent[];
  records: RunRecord[];
  now: Date;
  hold: HoldState;
  catchupFrom: string | null;
  retryFailed: boolean;
}): DuePlan {
  const nowDt = instant(input.now);
  if (input.hold) {
    if (!input.hold.until) {
      return { holdActive: true, holdExpired: false, missed: [], apply: null };
    }
    const until = DateTime.fromISO(input.hold.until, { setZone: true });
    if (until.isValid && until > nowDt) {
      return { holdActive: true, holdExpired: false, missed: [], apply: null };
    }
  }
  const holdExpired = Boolean(input.hold);
  if (!input.catchupFrom) {
    return { holdActive: false, holdExpired, missed: [], apply: null };
  }
  const catchup = DateTime.fromISO(input.catchupFrom, { setZone: true });
  const windowStart = nowDt.minus({ days: LOOKBACK_DAYS });
  const start = catchup > windowStart ? catchup : windowStart;
  const due = listOccurrences(input.events, start.plus({ milliseconds: 1 }), nowDt);
  const statuses = statusByKey(input.records);
  const open = due.filter((item) => {
    const status = statuses.get(item.key);
    if (!status) {
      return true;
    }
    return status === 'failed';
  });
  if (open.length === 0) {
    return { holdActive: false, holdExpired, missed: [], apply: null };
  }
  const latest = open[open.length - 1];
  const missed = open.slice(0, -1);
  const latestStatus = statuses.get(latest.key);
  if (latestStatus === 'failed' && !input.retryFailed) {
    return { holdActive: false, holdExpired, missed, apply: null };
  }
  return { holdActive: false, holdExpired, missed, apply: latest };
}

export function upsertRecord(records: RunRecord[], record: RunRecord): RunRecord[] {
  const next = records.filter((item) => item.key !== record.key);
  next.push(record);
  if (next.length > 400) {
    return next.slice(next.length - 400);
  }
  return next;
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

export function holdCopy(setpoint: number, hold: HoldState): string {
  if (!hold) {
    return 'Following schedule';
  }
  if (!hold.until) {
    return `Holding ${setpoint}° · no schedule ahead`;
  }
  return `Holding ${setpoint}° until ${hold.label} · ${formatHoldTime(hold.until)}`;
}

function formatHoldTime(iso: string): string {
  const instantAt = DateTime.fromISO(iso, { setZone: true }).setZone(TIME_ZONE);
  if (!instantAt.isValid) {
    return '';
  }
  return instantAt.toFormat('h:mm a');
}
