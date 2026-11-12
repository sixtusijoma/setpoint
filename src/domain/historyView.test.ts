import { describe, expect, it } from 'vitest';

import { changeLogItems, idleChangeLog, pendingPage, reduceChangeLog, type ChangeLog } from '@/domain/changeLog';
import {
  bucketLabel,
  chartGeometry,
  dataSignature,
  describeChangeSource,
  focusWithin,
  formatReadoutTime,
  idleFocus,
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
import { offHistoryLoad, reduceHistoryLoad } from '@/domain/historyLoad';
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

describe('history window load', () => {
  it('only settles the latest request', () => {
    let load = offHistoryLoad();
    load = reduceHistoryLoad(load, { type: 'fetch', span: 'day' });
    const firstRequest = load.request;
    load = reduceHistoryLoad(load, { type: 'fetch', span: 'month' });
    expect(reduceHistoryLoad(load, { type: 'loaded', request: firstRequest })).toBe(load);
    const failed = reduceHistoryLoad(load, { type: 'fail', request: load.request, message: 'Offline.' });
    expect(failed).toMatchObject({ status: 'error', span: 'month', message: 'Offline.' });
    expect(reduceHistoryLoad(failed, { type: 'loaded', request: load.request })).toBe(failed);
    const ready = reduceHistoryLoad(reduceHistoryLoad(failed, { type: 'fetch', span: 'month' }), {
      type: 'loaded',
      request: failed.request + 1,
    });
    expect(ready).toMatchObject({ status: 'ready', span: 'month' });
    const off = reduceHistoryLoad(ready, { type: 'off' });
    expect(off.status).toBe('off');
    expect(reduceHistoryLoad(off, { type: 'off' })).toBe(off);
    expect(reduceHistoryLoad(off, { type: 'loaded', request: off.request })).toBe(off);
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
