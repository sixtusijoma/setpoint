import { describe, expect, it } from 'vitest';

import { changeLogItems, idleChangeLog, pendingPage, reduceChangeLog, type ChangeLog } from '@/domain/changeLog';
import {
  bucketLabel,
  chartGeometry,
  dataSignature,
  describeChangeSource,
  focusWithin,
  formatReadoutTime,
  formatTooltipTime,
  idleFocus,
  markerRug,
  nearestIndex,
  nearestMarker,
  pickAt,
  reduceChartFocus,
  snappedMarker,
  timeTicks,
  type ChartFocus,
  type ChartFrame,
  type ChartPick,
} from '@/domain/chart';
import {
  changePageQuery,
  decodeChangeCursor,
  encodeChangeCursor,
  pageLocalChanges,
  readChangePage,
  type HistorySample,
  type SetpointChange,
} from '@/domain/history';
import {
  calendarMonth,
  canStepBack,
  canStepForward,
  historyWindow,
  initialHistoryView,
  localWindowData,
  monthTitle,
  reduceHistoryView,
  shiftMonth,
  viewWindow,
  windowLabel,
  type HistoryView,
  type HistoryViewEvent,
  type HistoryWindowData,
} from '@/domain/historyWindow';
import { defaultEvents } from '@/domain/schedule';

const change = (index: number, at = new Date(Date.UTC(2026, 9, 1) + index * 3600_000).toISOString()): SetpointChange => ({
  at,
  setpoint: 60 + (index % 10),
  source: 'manual',
  label: `Manual · ${60 + (index % 10)}°`,
});

function settle(log: ChangeLog, changes: SetpointChange[], nextCursor: string | null): ChangeLog {
  const pending = pendingPage(log);
  if (!pending) {
    throw new Error(`expected loading, got ${log.status}`);
  }
  return reduceChangeLog(log, { type: 'page', request: pending.request, changes, nextCursor });
}

describe('setpoint change pages', () => {
  it('walks idle, loading, loaded, exhausted and appends older pages', () => {
    let log = idleChangeLog();
    expect(changeLogItems(log)).toEqual([]);
    expect(pendingPage(log)).toBeNull();
    log = reduceChangeLog(log, { type: 'start' });
    expect(log).toMatchObject({ status: 'loading', items: [], cursor: null });
    log = settle(log, [change(3), change(2)], 'c1');
    expect(log).toMatchObject({ status: 'loaded', cursor: 'c1' });
    log = reduceChangeLog(log, { type: 'more' });
    expect(pendingPage(log)).toMatchObject({ cursor: 'c1' });
    log = settle(log, [change(1), change(0)], null);
    expect(log.status).toBe('exhausted');
    expect(changeLogItems(log).map((item) => item.at)).toEqual([change(3).at, change(2).at, change(1).at, change(0).at]);
  });

  it('keeps loaded rows on a failed page and retries the same cursor', () => {
    let log = reduceChangeLog(idleChangeLog(), { type: 'start' });
    log = settle(log, [change(5)], 'c1');
    log = reduceChangeLog(log, { type: 'more' });
    const failed = reduceChangeLog(log, { type: 'fail', request: pendingPage(log)?.request ?? -1, message: 'Offline.' });
    expect(failed).toMatchObject({ status: 'error', cursor: 'c1', message: 'Offline.' });
    expect(changeLogItems(failed)).toHaveLength(1);
    const retried = reduceChangeLog(failed, { type: 'retry' });
    expect(pendingPage(retried)).toEqual({ request: (pendingPage(log)?.request ?? 0) + 1, cursor: 'c1' });
  });

  it('ignores impossible and stale events', () => {
    const idle = idleChangeLog();
    expect(reduceChangeLog(idle, { type: 'more' })).toBe(idle);
    expect(reduceChangeLog(idle, { type: 'retry' })).toBe(idle);
    expect(reduceChangeLog(idle, { type: 'page', request: 0, changes: [change(1)], nextCursor: 'x' })).toBe(idle);
    const loading = reduceChangeLog(idle, { type: 'start' });
    expect(reduceChangeLog(loading, { type: 'start' })).toBe(loading);
    expect(reduceChangeLog(loading, { type: 'more' })).toBe(loading);
    expect(reduceChangeLog(loading, { type: 'retry' })).toBe(loading);
    expect(reduceChangeLog(loading, { type: 'page', request: 99, changes: [change(1)], nextCursor: null })).toBe(loading);
    expect(reduceChangeLog(loading, { type: 'fail', request: 99, message: 'late' })).toBe(loading);
    const reset = reduceChangeLog(loading, { type: 'reset' });
    const stale = reduceChangeLog(reset, {
      type: 'page',
      request: pendingPage(loading)?.request ?? 0,
      changes: [change(1)],
      nextCursor: 'old',
    });
    expect(stale).toBe(reset);
    const exhausted = settle(reset, [], null);
    expect(exhausted).toMatchObject({ status: 'exhausted', items: [] });
    expect(reduceChangeLog(exhausted, { type: 'more' })).toBe(exhausted);
    expect(reduceChangeLog(exhausted, { type: 'retry' })).toBe(exhausted);
  });

  it('stops when a server repeats a page instead of looping', () => {
    let log = settle(reduceChangeLog(idleChangeLog(), { type: 'start' }), [change(2), change(1)], 'c1');
    log = reduceChangeLog(log, { type: 'more' });
    const repeated = settle(log, [change(2), change(1)], 'c2');
    expect(repeated.status).toBe('exhausted');
    expect(changeLogItems(repeated)).toHaveLength(2);
    const loop = settle(log, [change(0)], 'c1');
    expect(loop.status).toBe('exhausted');
    expect(changeLogItems(loop)).toHaveLength(3);
  });

  it('pages local changes newest first by offset', () => {
    const all = Array.from({ length: 52 }, (_, index) => change(index));
    const first = pageLocalChanges(all, null, 15);
    expect(first.changes[0]?.at).toBe(change(51).at);
    expect(first.nextCursor).toBe('15');
    const last = pageLocalChanges(all, '45', 15);
    expect(last.changes).toHaveLength(7);
    expect(last.changes[6]?.at).toBe(change(0).at);
    expect(last.nextCursor).toBeNull();
    expect(() => pageLocalChanges(all, 'abc', 15)).toThrow(/cursor/);
    expect(pageLocalChanges([], null, 15)).toEqual({ changes: [], nextCursor: null });
  });

  it('reads the server page and falls back to the legacy history body', () => {
    expect(readChangePage({ changes: [change(1)], nextCursor: 'abc' })).toEqual({ changes: [change(1)], nextCursor: 'abc' });
    expect(readChangePage({ changes: [change(1)], nextCursor: null }).nextCursor).toBeNull();
    const legacy = readChangePage({ changes: [change(1), change(3), change(2)] });
    expect(legacy.nextCursor).toBeNull();
    expect(legacy.changes.map((item) => item.at)).toEqual([change(3).at, change(2).at, change(1).at]);
    expect(readChangePage({}).changes).toEqual([]);
  });

  it('round-trips the opaque cursor and rejects junk', () => {
    const cursor = encodeChangeCursor({ id: 812, at: '2026-11-11T23:51:00.123456+00:00' });
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeChangeCursor(cursor)).toEqual({ id: 812, at: '2026-11-11T23:51:00.123456+00:00' });
    expect(decodeChangeCursor('***')).toBeNull();
    expect(decodeChangeCursor(encodeChangeCursor({ id: 1, at: 'yesterday' }))).toBeNull();
    expect(changePageQuery({})).toEqual({ limit: 20, before: null });
    expect(changePageQuery({ limit: '7.9', cursor })).toEqual({ limit: 7, before: { id: 812, at: '2026-11-11T23:51:00.123456+00:00' } });
    expect(() => changePageQuery({ cursor: 'nope' })).toThrow(/cursor/);
  });
});

const TODAY = '2026-11-12';
const EARLIEST = '2025-11-22T14:05:00.000Z';

function run(view: HistoryView, ...events: HistoryViewEvent[]): HistoryView {
  return events.reduce(reduceHistoryView, view);
}

function windowData(firstAt: string | null = EARLIEST): HistoryWindowData {
  return { samples: [], changes: [], bucketSeconds: 300, firstAt };
}

function loadedView(span: HistoryView['span'] = 'day'): HistoryView {
  const view = run(initialHistoryView(), { type: 'span', span, today: TODAY });
  const fetched = reduceHistoryView(view, { type: 'fetch', window: viewWindow(view, TODAY) });
  return reduceHistoryView(fetched, { type: 'loaded', request: fetched.load.request, data: windowData(), today: TODAY });
}

describe('history windows', () => {
  it('covers whole Eastern Time days and sends exact since and until instants', () => {
    const day = historyWindow('day', '2026-11-12');
    expect(day).toMatchObject({
      key: 'day:2026-11-12',
      firstDay: '2026-11-12',
      since: '2026-11-12T05:00:00.000Z',
      until: '2026-11-13T04:59:59.999Z',
      bucketSeconds: 300,
    });
    expect(day.endMs - day.startMs).toBe(24 * 3600_000);
    const week = historyWindow('week', '2026-10-11');
    expect(week).toMatchObject({ firstDay: '2026-10-05', since: '2026-10-05T04:00:00.000Z', bucketSeconds: 1800 });
    expect(windowLabel(week)).toBe('Oct 5 to Oct 11, 2026');
    expect(windowLabel(day)).toBe('Thu, Nov 12, 2026');
    const month = historyWindow('month', '2026-03-15');
    expect(month).toMatchObject({ firstDay: '2026-02-16', bucketSeconds: 7200 });
    const year = historyWindow('year', '2026-11-12');
    expect(year).toMatchObject({ firstDay: '2025-11-13', since: '2025-11-13T05:00:00.000Z', bucketSeconds: 86400 });
    expect(windowLabel(year)).toBe('Nov 13, 2025 to Nov 12, 2026');
  });

  it('keeps DST days whole at five minute buckets', () => {
    const fallBack = historyWindow('day', '2026-11-01');
    expect(fallBack.endMs - fallBack.startMs).toBe(25 * 3600_000);
    expect(fallBack).toMatchObject({ since: '2026-11-01T04:00:00.000Z', until: '2026-11-02T04:59:59.999Z', bucketSeconds: 300 });
    const springForward = historyWindow('day', '2026-03-08');
    expect(springForward.endMs - springForward.startMs).toBe(23 * 3600_000);
    expect(springForward).toMatchObject({ since: '2026-03-08T05:00:00.000Z', until: '2026-03-09T03:59:59.999Z' });
    const week = historyWindow('week', '2026-11-04');
    expect(week.endMs - week.startMs).toBe((7 * 24 + 1) * 3600_000);
    expect(week.bucketSeconds).toBe(1800);
  });

  it('slices and buckets local readings to the window', () => {
    const window = historyWindow('day', '2026-11-11');
    const samples = hourly(48, '2026-11-10T12:00:00.000Z');
    const changes = [change(0, '2026-11-11T04:59:00.000Z'), change(1, '2026-11-11T12:00:00.000Z')];
    const data = localWindowData(samples, changes, window);
    expect(data.firstAt).toBe('2026-11-10T12:00:00.000Z');
    expect(data.samples).toHaveLength(24);
    expect(data.samples[0]?.at).toBe('2026-11-11T05:00:00.000Z');
    expect(data.changes.map((item) => item.at)).toEqual(['2026-11-11T12:00:00.000Z']);
    expect(localWindowData([], [], window).firstAt).toBeNull();
  });
});

describe('history window navigation', () => {
  it('follows today until stepped back and returns to now', () => {
    const view = initialHistoryView();
    expect(viewWindow(view, TODAY).lastDay).toBe(TODAY);
    expect(viewWindow(view, '2026-11-13').lastDay).toBe('2026-11-13');
    expect(canStepForward(view, TODAY)).toBe(false);
    expect(reduceHistoryView(view, { type: 'step', by: 1, today: TODAY })).toBe(view);
    const back = run(view, { type: 'span', span: 'week', today: TODAY }, { type: 'step', by: -1, today: TODAY });
    expect(back.lastDay).toBe('2026-11-05');
    expect(windowLabel(viewWindow(back, TODAY))).toBe('Oct 30 to Nov 5, 2026');
    expect(canStepForward(back, TODAY)).toBe(true);
    expect(run(back, { type: 'step', by: 1, today: TODAY }).lastDay).toBeNull();
    expect(run(back, { type: 'now' }).lastDay).toBeNull();
    const months = run(back, { type: 'span', span: 'month', today: TODAY }, { type: 'step', by: -1, today: TODAY });
    expect(months.lastDay).toBe('2026-10-05');
    expect(viewWindow(months, TODAY).firstDay).toBe('2026-09-06');
  });

  it('steps across DST without losing whole days', () => {
    const view = run(initialHistoryView(), { type: 'jump', date: '2026-11-02', today: TODAY });
    const fallBack = run(view, { type: 'step', by: -1, today: TODAY });
    expect(fallBack.lastDay).toBe('2026-11-01');
    expect(viewWindow(fallBack, TODAY).until).toBe('2026-11-02T04:59:59.999Z');
    const spring = run(view, { type: 'jump', date: '2026-03-09', today: TODAY }, { type: 'step', by: -1, today: TODAY });
    expect(viewWindow(spring, TODAY)).toMatchObject({ lastDay: '2026-03-08', since: '2026-03-08T05:00:00.000Z' });
  });

  it('stops at the earliest stored reading', () => {
    let view = run(loadedView('month'), { type: 'jump', date: '2025-12-30', today: TODAY });
    expect(view.earliestDay).toBe('2025-11-22');
    expect(viewWindow(view, TODAY).firstDay).toBe('2025-11-30');
    expect(canStepBack(view, TODAY)).toBe(true);
    view = run(view, { type: 'step', by: -1, today: TODAY });
    expect(viewWindow(view, TODAY)).toMatchObject({ lastDay: '2025-11-30', firstDay: '2025-11-01' });
    expect(canStepBack(view, TODAY)).toBe(false);
    expect(run(view, { type: 'step', by: -1, today: TODAY })).toBe(view);
    expect(run(view, { type: 'jump', date: '2024-01-01', today: TODAY }).lastDay).toBe('2025-11-22');
    expect(run(view, { type: 'jump', date: '2027-01-01', today: TODAY }).lastDay).toBeNull();
    expect(run(view, { type: 'jump', date: '2026-02-30', today: TODAY })).toBe(view);
    expect(canStepBack(initialHistoryView(), TODAY)).toBe(true);
  });

  it('reads bounds from local data and from server responses', () => {
    const bounded = run(initialHistoryView(), { type: 'bounds', firstAt: '2026-01-01T03:00:00.000Z', today: TODAY });
    expect(bounded.earliestDay).toBe('2025-12-31');
    expect(run(bounded, { type: 'bounds', firstAt: null, today: TODAY }).earliestDay).toBe(TODAY);
    const fetched = run(bounded, { type: 'fetch', window: viewWindow(bounded, TODAY) });
    const legacy = run(fetched, {
      type: 'loaded',
      request: fetched.load.request,
      data: { samples: [], changes: [], bucketSeconds: 300 },
      today: TODAY,
    });
    expect(legacy.earliestDay).toBe('2025-12-31');
    expect(legacy.load.status).toBe('ready');
  });

  it('never lets an older window response overwrite a newer one', () => {
    const view = loadedView('week');
    const old = run(view, { type: 'step', by: -1, today: TODAY });
    const oldFetch = run(old, { type: 'fetch', window: viewWindow(old, TODAY) });
    const newer = run(oldFetch, { type: 'step', by: -1, today: TODAY });
    const newerFetch = run(newer, { type: 'fetch', window: viewWindow(newer, TODAY) });
    const oldRequest = oldFetch.load.request;
    expect(newerFetch.load.request).toBe(oldRequest + 1);
    const late = { samples: hourly(2), changes: [], bucketSeconds: 1800, firstAt: EARLIEST };
    expect(run(newerFetch, { type: 'loaded', request: oldRequest, data: late, today: TODAY })).toBe(newerFetch);
    expect(run(newerFetch, { type: 'fail', request: oldRequest, message: 'late' })).toBe(newerFetch);
    const settled = run(newerFetch, { type: 'loaded', request: newerFetch.load.request, data: windowData(), today: TODAY });
    expect(settled.load).toMatchObject({ status: 'ready', window: { key: 'week:2026-10-29' } });
    expect(run(settled, { type: 'loaded', request: oldRequest, data: late, today: TODAY })).toBe(settled);
    const off = run(settled, { type: 'off' });
    expect(off.load.status).toBe('off');
    expect(run(off, { type: 'off' })).toBe(off);
    expect(run(off, { type: 'loaded', request: off.load.request, data: late, today: TODAY })).toBe(off);
  });

  it('keeps the error with its window so retry asks again', () => {
    const fetched = run(loadedView(), { type: 'fetch', window: historyWindow('day', '2026-06-01') });
    const failed = run(fetched, { type: 'fail', request: fetched.load.request, message: 'Offline.' });
    expect(failed.load).toMatchObject({ status: 'error', message: 'Offline.', window: { key: 'day:2026-06-01' } });
    const retried = run(failed, { type: 'fetch', window: historyWindow('day', '2026-06-01') });
    expect(retried.load).toMatchObject({ status: 'loading', request: fetched.load.request + 1 });
  });
});

describe('date picker month', () => {
  it('lays out Monday-first weeks and disables days outside the stored range', () => {
    const weeks = calendarMonth('2025-11-30', '2025-11-22', TODAY);
    expect(monthTitle('2025-11-30')).toBe('November 2025');
    expect(weeks[0]?.[0]).toMatchObject({ date: '2025-10-27', inMonth: false, enabled: false });
    const days = weeks.flat();
    expect(days.find((item) => item.date === '2025-11-21')?.enabled).toBe(false);
    expect(days.find((item) => item.date === '2025-11-22')?.enabled).toBe(true);
    expect(days.at(-1)?.date).toBe('2025-11-30');
    const now = calendarMonth(TODAY, null, TODAY).flat();
    expect(now.find((item) => item.date === TODAY)?.enabled).toBe(true);
    expect(now.find((item) => item.date === '2026-11-13')?.enabled).toBe(false);
    expect(shiftMonth('2026-01-31', -1)).toBe('2025-12-01');
  });
});

const frame: ChartFrame = { width: 340, height: 180, top: 30, bottom: 6, left: 6, right: 46 };

function hourly(count: number, startIso = '2026-11-11T00:00:00.000Z'): HistorySample[] {
  const start = Date.parse(startIso);
  return Array.from({ length: count }, (_, index) => ({
    at: new Date(start + index * 3600_000).toISOString(),
    temperatureF: 60 + index,
    humidity: 40,
    co2Ppm: 700,
  }));
}

function pick(sample: number, marker: number | null = null, samples = 10, markers = 3): ChartPick {
  return { sample, marker, samples, markers };
}

describe('chart geometry', () => {
  it('turns a window crowded with changes into a rug of ticks', () => {
    const domain = { startMs: Date.parse('2025-11-13T05:00:00.000Z'), endMs: Date.parse('2026-11-13T05:00:00.000Z') };
    const yearOfChanges = Array.from({ length: 700 }, (_, index) =>
      change(index, new Date(domain.startMs + index * 12 * 3600_000).toISOString()),
    );
    const year = chartGeometry(hourly(3), yearOfChanges, 'temperatureF', frame, domain);
    const rug = markerRug(year);
    expect(rug).not.toBeNull();
    expect(new Set(rug).size).toBe(rug?.length);
    expect(rug?.length).toBeLessThanOrEqual(Math.ceil(year.plotRight - year.plotLeft) + 1);
    expect(year.markers).toHaveLength(700);
    const month = chartGeometry(hourly(3), yearOfChanges.slice(0, 60), 'temperatureF', frame);
    expect(markerRug(month)).toBeNull();
  });

  it('maps samples and markers into the plot and labels min and max', () => {
    const samples = hourly(5);
    const changes = [change(0, '2026-11-11T02:00:00.000Z'), change(1, '2026-11-11T04:30:00.000Z')];
    const geometry = chartGeometry(samples, changes, 'temperatureF', frame);
    expect(geometry.min).toBe(60);
    expect(geometry.max).toBe(64);
    expect(geometry.xs[0]).toBe(frame.left);
    expect(geometry.plotRight).toBe(frame.width - frame.right);
    expect(geometry.xs[4]).toBeLessThan(geometry.plotRight);
    expect(geometry.markers.map((marker) => marker.change)).toEqual([0, 1]);
    expect(geometry.markers[1]?.x).toBe(geometry.plotRight);
    expect(geometry.ys[0]).toBe(geometry.plotBottom);
    expect(geometry.ys[4]).toBe(geometry.plotTop);
    expect(geometry.points.split(' ')).toHaveLength(5);
  });

  it('keeps a flat series and an empty series drawable', () => {
    const flat = chartGeometry(hourly(3).map((sample) => ({ ...sample, temperatureF: 68 })), [], 'temperatureF', frame);
    expect(flat.min).toBe(67);
    expect(flat.max).toBe(69);
    const empty = chartGeometry([], [], 'humidity', frame);
    expect(empty.points).toBe('');
    expect(pickAt(empty, 100)).toBeNull();
    expect(timeTicks(empty)).toEqual([]);
  });

  it('finds the nearest sample and only snaps to close setpoint lines', () => {
    const xs = [0, 10, 20, 30];
    expect(nearestIndex(xs, -5)).toBe(0);
    expect(nearestIndex(xs, 14)).toBe(1);
    expect(nearestIndex(xs, 16)).toBe(2);
    expect(nearestIndex(xs, 15)).toBe(1);
    expect(nearestIndex(xs, 99)).toBe(3);
    expect(nearestIndex([], 4)).toBe(-1);
    const markers = [
      { x: 50, change: 4 },
      { x: 120, change: 2 },
    ];
    expect(nearestMarker(markers, 58, 12)).toBe(4);
    expect(nearestMarker(markers, 85, 12)).toBeNull();
    expect(nearestMarker([], 85, 12)).toBeNull();
  });

  it('stays fast enough to scrub a month of two-hour buckets', () => {
    const samples = hourly(24 * 31).filter((_, index) => index % 2 === 0);
    const changes = Array.from({ length: 80 }, (_, index) => change(index, new Date(Date.parse(samples[0]?.at ?? '') + index * 9 * 3600_000).toISOString()));
    const geometry = chartGeometry(samples, changes, 'temperatureF', frame);
    const started = performance.now();
    for (let x = 0; x < 2000; x += 1) {
      pickAt(geometry, x % frame.width);
    }
    expect(performance.now() - started).toBeLessThan(250);
  });

  it('puts time ticks on Eastern Time boundaries across the DST change', () => {
    const day = chartGeometry(hourly(26, '2026-11-01T04:00:00.000Z'), [], 'temperatureF', frame);
    const dayTicks = timeTicks(day);
    expect(dayTicks.map((tick) => tick.label)).toEqual(['12 AM', '6 AM', '12 PM', '6 PM', '12 AM']);
    const perHour = (day.plotRight - day.plotLeft) / 25;
    expect((dayTicks[1]?.x ?? 0) - day.plotLeft).toBeCloseTo(7 * perHour, 5);
    const week = chartGeometry(hourly(24 * 7, '2026-11-06T05:00:00.000Z'), [], 'temperatureF', frame);
    expect(timeTicks(week).map((tick) => tick.label)).toEqual(['Fri', 'Sat', 'Sun', 'Mon', 'Tue', 'Wed', 'Thu']);
    const month = chartGeometry(hourly(24 * 30, '2026-10-13T16:00:00.000Z'), [], 'temperatureF', frame);
    const labels = timeTicks(month).map((tick) => tick.label);
    expect(labels).toEqual(['Oct 19', 'Oct 26', 'Nov 2', 'Nov 9']);
    for (const tick of timeTicks(month)) {
      expect(tick.x).toBeGreaterThanOrEqual(month.plotLeft);
      expect(tick.x).toBeLessThanOrEqual(month.plotRight);
    }
  });

  it('formats readouts in Eastern Time', () => {
    expect(formatReadoutTime('2026-11-11T23:51:00.000Z')).toBe('Wed, Nov 11 · 6:51 PM ET');
    expect(formatReadoutTime('2026-07-04T16:00:00+00:00')).toBe('Sat, Jul 4 · 12:00 PM ET');
    expect(bucketLabel(300)).toBe('5-min average');
    expect(bucketLabel(7200)).toBe('2-hour average');
    expect(bucketLabel(0)).toBe('Reading');
    const day = 24 * 3600 * 1000;
    expect(formatTooltipTime('2026-11-02T16:00:00Z', day)).toBe('11:00 AM');
    expect(formatTooltipTime('2026-11-02T16:30:00Z', 7 * day)).toBe('Mon 11:30 AM');
    expect(formatTooltipTime('2026-11-02T16:00:00Z', 30 * day)).toBe('Nov 2, 11 AM');
  });

  it('names where a change came from', () => {
    const events = defaultEvents();
    const at = (iso: string, source: string, label: string, setpoint = 70): SetpointChange => ({ at: iso, source, label, setpoint });
    expect(describeChangeSource(at('2026-11-11T11:46:00.000Z', 'schedule', 'Schedule · 70°'), events)).toBe('Schedule · Wake');
    expect(describeChangeSource(at('2026-11-12T04:45:30.000Z', 'schedule', 'Schedule · 61°', 61), events)).toBe('Schedule · Sleep');
    expect(describeChangeSource(at('2026-11-15T04:45:00.000Z', 'schedule', 'Schedule · 61°', 61), events)).toBe('Schedule');
    expect(describeChangeSource(at('2026-11-11T15:00:00.000Z', 'schedule', 'Schedule · 70°'), events)).toBe('Schedule');
    expect(describeChangeSource(at('2026-11-11T15:00:00.000Z', 'manual', 'Manual · 69°'), events)).toBe('Manual');
    expect(describeChangeSource(at('2026-11-11T15:00:00.000Z', 'manual', 'Home · 72°'), events)).toBe('Home preset');
    expect(describeChangeSource(at('2026-11-11T15:00:00.000Z', 'manual', 'Calibrated · 68°'), events)).toBe('Calibrated');
    expect(describeChangeSource(at('2026-11-11T15:00:00.000Z', 'recalibrated', 'Recalibrated · 66°'), events)).toBe('Recalibrated');
    expect(describeChangeSource(at('2026-11-11T15:00:00.000Z', 'wake-now', 'Wake now · 70°'), events)).toBe('Wake now');
    expect(describeChangeSource(at('2026-11-11T15:00:00.000Z', 'run-now', 'Nap now · 66°'), events)).toBe('Nap now');
  });
});

describe('chart focus', () => {
  it('scrubs, follows snaps, and returns to idle on release', () => {
    let focus: ChartFocus = idleFocus();
    focus = reduceChartFocus(focus, { type: 'scrub', pick: pick(2) });
    expect(focus).toEqual({ kind: 'scrubbing', sample: 2, marker: null });
    const same = reduceChartFocus(focus, { type: 'scrub', pick: pick(2) });
    expect(same).toBe(focus);
    focus = reduceChartFocus(focus, { type: 'scrub', pick: pick(3, 1) });
    expect(focus).toEqual({ kind: 'scrubbing', sample: 3, marker: 1 });
    expect(reduceChartFocus(focus, { type: 'release' })).toEqual({ kind: 'idle' });
  });

  it('pins a tap, toggles it off, and dismisses', () => {
    const pinned = reduceChartFocus(idleFocus(), { type: 'tap', pick: pick(4, 2) });
    expect(pinned).toEqual({ kind: 'pinned', sample: 4, marker: 2 });
    expect(reduceChartFocus(pinned, { type: 'release' })).toBe(pinned);
    expect(reduceChartFocus(pinned, { type: 'tap', pick: pick(4, 2) })).toEqual({ kind: 'idle' });
    expect(reduceChartFocus(pinned, { type: 'tap', pick: pick(6) })).toEqual({ kind: 'pinned', sample: 6, marker: null });
    expect(reduceChartFocus(pinned, { type: 'dismiss' })).toEqual({ kind: 'idle' });
    expect(reduceChartFocus(pinned, { type: 'scrub', pick: pick(1) })).toEqual({ kind: 'scrubbing', sample: 1, marker: null });
    expect(reduceChartFocus(pinned, { type: 'data' })).toEqual({ kind: 'idle' });
  });

  it('refuses impossible picks and stray events', () => {
    const idle = idleFocus();
    expect(reduceChartFocus(idle, { type: 'scrub', pick: pick(10) })).toBe(idle);
    expect(reduceChartFocus(idle, { type: 'scrub', pick: pick(-1) })).toBe(idle);
    expect(reduceChartFocus(idle, { type: 'scrub', pick: pick(1.5) })).toBe(idle);
    expect(reduceChartFocus(idle, { type: 'tap', pick: pick(1, 3) })).toBe(idle);
    expect(reduceChartFocus(idle, { type: 'release' })).toBe(idle);
    expect(reduceChartFocus(idle, { type: 'dismiss' })).toBe(idle);
    expect(reduceChartFocus(idle, { type: 'data' })).toBe(idle);
    const scrubbing = reduceChartFocus(idle, { type: 'scrub', pick: pick(1) });
    expect(reduceChartFocus(scrubbing, { type: 'tap', pick: pick(5) })).toBe(scrubbing);
    expect(reduceChartFocus(scrubbing, { type: 'data' })).toBe(scrubbing);
    expect(focusWithin(scrubbing, 1, 0)).toEqual({ kind: 'idle' });
    expect(focusWithin(scrubbing, 2, 0)).toBe(scrubbing);
    expect(focusWithin({ kind: 'pinned', sample: 0, marker: 4 }, 2, 3)).toEqual({ kind: 'idle' });
  });

  it('ticks haptics only when the scrub lands on a new setpoint line', () => {
    expect(snappedMarker(null, { kind: 'scrubbing', sample: 1, marker: 2 })).toBe(true);
    expect(snappedMarker(2, { kind: 'scrubbing', sample: 2, marker: 2 })).toBe(false);
    expect(snappedMarker(2, { kind: 'scrubbing', sample: 3, marker: null })).toBe(false);
    expect(snappedMarker(null, { kind: 'idle' })).toBe(false);
    expect(snappedMarker(2, { kind: 'pinned', sample: 3, marker: 1 })).toBe(true);
  });

  it('changes the data signature only when the window moves', () => {
    const samples = hourly(3);
    expect(dataSignature(samples, [])).toBe(dataSignature([...samples], []));
    expect(dataSignature(samples, [])).not.toBe(dataSignature(hourly(4), []));
    expect(dataSignature(samples, [])).not.toBe(dataSignature(samples, [change(1)]));
  });
});
