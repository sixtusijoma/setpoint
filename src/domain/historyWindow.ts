import { DateTime } from 'luxon';

import {
  aggregateSamples,
  bucketSecondsForRange,
  withinRange,
  type HistorySample,
  type HistorySpan,
  type SetpointChange,
} from './history';
import { TIME_ZONE } from './time';

export const HISTORY_SPANS: { id: HistorySpan; label: string }[] = [
  { id: 'day', label: 'Day' },
  { id: 'week', label: 'Week' },
  { id: 'month', label: 'Month' },
  { id: 'year', label: 'Year' },
];

const STEP: Record<HistorySpan, 'days' | 'weeks' | 'months' | 'years'> = {
  day: 'days',
  week: 'weeks',
  month: 'months',
  year: 'years',
};

export type HistoryWindow = {
  key: string;
  span: HistorySpan;
  firstDay: string;
  lastDay: string;
  since: string;
  until: string;
  startMs: number;
  endMs: number;
  bucketSeconds: number;
};

export type HistoryWindowData = {
  samples: HistorySample[];
  changes: SetpointChange[];
  bucketSeconds: number;
  firstAt?: string | null;
};

function day(date: string): DateTime {
  return DateTime.fromISO(date, { zone: TIME_ZONE }).startOf('day');
}

function isoDay(value: DateTime): string {
  return value.toFormat('yyyy-MM-dd');
}

export function isDay(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && day(value).isValid;
}

export function etDay(at: Date | string): string {
  const instant =
    typeof at === 'string' ? DateTime.fromISO(at, { setZone: true }) : DateTime.fromJSDate(at);
  return isoDay(instant.setZone(TIME_ZONE));
}

// Whole Eastern Time days ending with lastDay: one day, the 7 days, or one calendar month or year back.
export function historyWindow(span: HistorySpan, lastDay: string): HistoryWindow {
  const end = day(lastDay).plus({ days: 1 });
  const start = end.minus({ [STEP[span]]: 1 });
  const startMs = start.toMillis();
  const endMs = end.toMillis();
  return {
    key: `${span}:${lastDay}`,
    span,
    firstDay: isoDay(start),
    lastDay,
    since: start.toUTC().toISO() ?? '',
    until: end.minus({ milliseconds: 1 }).toUTC().toISO() ?? '',
    startMs,
    endMs,
    bucketSeconds: bucketSecondsForRange(endMs - startMs),
  };
}

export function shiftDay(span: HistorySpan, lastDay: string, by: number): string {
  return isoDay(day(lastDay).plus({ [STEP[span]]: by }));
}

export function windowLabel(window: HistoryWindow): string {
  const first = day(window.firstDay);
  const last = day(window.lastDay);
  if (window.span === 'day') {
    return last.toFormat('ccc, LLL d, yyyy');
  }
  if (first.year === last.year) {
    return `${first.toFormat('LLL d')} to ${last.toFormat('LLL d, yyyy')}`;
  }
  return `${first.toFormat('LLL d, yyyy')} to ${last.toFormat('LLL d, yyyy')}`;
}

export function localWindowData(
  history: HistorySample[],
  changes: SetpointChange[],
  window: HistoryWindow,
): HistoryWindowData {
  const first = history.reduce<number | null>((earliest, sample) => {
    const time = Date.parse(sample.at);
    return Number.isFinite(time) && (earliest === null || time < earliest) ? time : earliest;
  }, null);
  return {
    samples: aggregateSamples(withinRange(history, window.since, window.until), window.bucketSeconds),
    changes: withinRange(changes, window.since, window.until),
    bucketSeconds: window.bucketSeconds,
    firstAt: first === null ? null : new Date(first).toISOString(),
  };
}

export type HistoryLoad =
  | { status: 'off'; request: number }
  | { status: 'loading'; request: number; window: HistoryWindow }
  | { status: 'ready'; request: number; window: HistoryWindow; data: HistoryWindowData }
  | { status: 'error'; request: number; window: HistoryWindow; message: string };

export type HistoryView = {
  span: HistorySpan;
  // null follows today, so the window keeps up when the date changes.
  lastDay: string | null;
  earliestDay: string | null;
  load: HistoryLoad;
};

export type HistoryViewEvent =
  | { type: 'span'; span: HistorySpan; today: string }
  | { type: 'step'; by: 1 | -1; today: string }
  | { type: 'jump'; date: string; today: string }
  | { type: 'now' }
  | { type: 'bounds'; firstAt: string | null; today: string }
  | { type: 'fetch'; window: HistoryWindow }
  | { type: 'off' }
  | { type: 'loaded'; request: number; data: HistoryWindowData; today: string }
  | { type: 'fail'; request: number; message: string };

export function initialHistoryView(): HistoryView {
  return { span: 'day', lastDay: null, earliestDay: null, load: { status: 'off', request: 0 } };
}

export function viewWindow(view: HistoryView, today: string): HistoryWindow {
  return historyWindow(view.span, view.lastDay === null || view.lastDay > today ? today : view.lastDay);
}

export function canStepBack(view: HistoryView, today: string): boolean {
  return view.earliestDay === null || viewWindow(view, today).firstDay > view.earliestDay;
}

export function canStepForward(view: HistoryView, today: string): boolean {
  return view.lastDay !== null && view.lastDay < today;
}

function clampDay(view: HistoryView, date: string, today: string): string | null {
  if (date >= today) {
    return null;
  }
  return view.earliestDay !== null && date < view.earliestDay ? view.earliestDay : date;
}

function earliestFrom(firstAt: string | null, today: string): string {
  return firstAt === null || !Number.isFinite(Date.parse(firstAt)) ? today : etDay(firstAt);
}

export function reduceHistoryView(view: HistoryView, event: HistoryViewEvent): HistoryView {
  switch (event.type) {
    case 'span':
      return event.span === view.span ? view : { ...view, span: event.span };
    case 'step': {
      if (event.by < 0 ? !canStepBack(view, event.today) : !canStepForward(view, event.today)) {
        return view;
      }
      const from = view.lastDay ?? event.today;
      return { ...view, lastDay: clampDay({ ...view, earliestDay: null }, shiftDay(view.span, from, event.by), event.today) };
    }
    case 'jump': {
      if (!isDay(event.date)) {
        return view;
      }
      const lastDay = clampDay(view, event.date, event.today);
      return lastDay === view.lastDay ? view : { ...view, lastDay };
    }
    case 'now':
      return view.lastDay === null ? view : { ...view, lastDay: null };
    case 'bounds': {
      const earliestDay = earliestFrom(event.firstAt, event.today);
      return earliestDay === view.earliestDay ? view : { ...view, earliestDay };
    }
    case 'fetch':
      return {
        ...view,
        load: { status: 'loading', request: view.load.request + 1, window: event.window },
      };
    case 'off':
      return view.load.status === 'off' ? view : { ...view, load: { status: 'off', request: view.load.request + 1 } };
    case 'loaded': {
      if (view.load.status !== 'loading' || view.load.request !== event.request) {
        return view;
      }
      const earliestDay =
        event.data.firstAt === undefined ? view.earliestDay : earliestFrom(event.data.firstAt, event.today);
      return {
        ...view,
        earliestDay,
        load: { status: 'ready', request: view.load.request, window: view.load.window, data: event.data },
      };
    }
    case 'fail':
      if (view.load.status !== 'loading' || view.load.request !== event.request) {
        return view;
      }
      return {
        ...view,
        load: { status: 'error', request: view.load.request, window: view.load.window, message: event.message },
      };
  }
}

export type CalendarDay = { date: string; label: string; inMonth: boolean; enabled: boolean };

// Monday-first weeks covering the month that contains `month` (any day in it).
export function calendarMonth(month: string, earliestDay: string | null, today: string): CalendarDay[][] {
  const first = day(month).startOf('month');
  const start = first.minus({ days: first.weekday - 1 });
  const last = first.endOf('month').startOf('day');
  const weeks: CalendarDay[][] = [];
  for (let cursor = start; cursor <= last; ) {
    const week: CalendarDay[] = [];
    for (let index = 0; index < 7; index += 1) {
      const date = isoDay(cursor);
      week.push({
        date,
        label: String(cursor.day),
        inMonth: cursor.month === first.month,
        enabled: date <= today && (earliestDay === null || date >= earliestDay),
      });
      cursor = cursor.plus({ days: 1 });
    }
    weeks.push(week);
  }
  return weeks;
}

export function monthTitle(month: string): string {
  return day(month).toFormat('LLLL yyyy');
}

export function shiftMonth(month: string, by: number): string {
  return isoDay(day(month).startOf('month').plus({ months: by }));
}
