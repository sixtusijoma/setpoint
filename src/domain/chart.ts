import { DateTime } from 'luxon';

import type { HistorySample, SetpointChange } from './history';
import type { ScheduleEvent } from './schedule';
import { TIME_ZONE } from './time';

export type ChartMetric = 'temperatureF' | 'humidity' | 'co2Ppm';

export type ChartFrame = {
  width: number;
  height: number;
  top: number;
  bottom: number;
  left: number;
  right: number;
};

export type ChartMarker = {
  x: number;
  change: number;
};

export type ChartGeometry = {
  xs: number[];
  ys: number[];
  points: string;
  min: number;
  max: number;
  startMs: number;
  endMs: number;
  plotLeft: number;
  plotRight: number;
  plotTop: number;
  plotBottom: number;
  markers: ChartMarker[];
  changeCount: number;
};

export type ChartTick = {
  x: number;
  label: string;
};

export type ChartPick = {
  sample: number;
  marker: number | null;
  samples: number;
  markers: number;
};

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export type ChartDomain = { startMs: number; endMs: number };

export function chartGeometry(
  samples: HistorySample[],
  changes: SetpointChange[],
  metric: ChartMetric,
  frame: ChartFrame,
  domain?: ChartDomain,
): ChartGeometry {
  const plotLeft = frame.left;
  const plotRight = Math.max(plotLeft + 1, frame.width - frame.right);
  const plotTop = frame.top;
  const plotBottom = Math.max(plotTop + 1, frame.height - frame.bottom);
  const times = samples.map((sample) => Date.parse(sample.at));
  const changeTimes = changes.map((change) => Date.parse(change.at));
  const known = [...times, ...changeTimes].filter((time) => Number.isFinite(time));
  const fixed = domain && domain.endMs > domain.startMs ? domain : null;
  const startMs = fixed ? fixed.startMs : known.length > 0 ? Math.min(...known) : 0;
  const endMs = fixed ? fixed.endMs : known.length > 0 ? Math.max(...known) : 0;
  const timeSpan = Math.max(1, endMs - startMs);
  const values = samples.map((sample) => sample[metric]);
  let min = values.length > 0 ? Math.min(...values) : 0;
  let max = values.length > 0 ? Math.max(...values) : 0;
  if (max === min) {
    min -= 1;
    max += 1;
  }
  const xFor = (time: number) => plotLeft + ((time - startMs) / timeSpan) * (plotRight - plotLeft);
  const yFor = (value: number) => plotBottom - ((value - min) / (max - min)) * (plotBottom - plotTop);
  const xs = times.map(xFor);
  const ys = values.map(yFor);
  const points = xs.map((x, index) => `${round(x)},${round(ys[index] ?? plotBottom)}`).join(' ');
  const markers = changeTimes
    .map((time, change) => ({ x: xFor(time), change, time }))
    .filter((marker) => Number.isFinite(marker.time))
    .sort((a, b) => a.x - b.x)
    .map(({ x, change }) => ({ x, change }));
  return { xs, ys, points, min, max, startMs, endMs, plotLeft, plotRight, plotTop, plotBottom, markers, changeCount: changes.length };
}

const RUG_GAP = 4;

// Too many changes for full-height lines (a year of schedule runs fills the plot), so they become
// short ticks along the bottom, one per pixel column.
export function markerRug(geometry: ChartGeometry): number[] | null {
  if (geometry.markers.length * RUG_GAP <= geometry.plotRight - geometry.plotLeft) {
    return null;
  }
  return [...new Set(geometry.markers.map((marker) => Math.round(marker.x)))];
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

export function nearestIndex(xs: number[], x: number): number {
  if (xs.length === 0) {
    return -1;
  }
  let low = 0;
  let high = xs.length - 1;
  while (low < high) {
    const mid = (low + high) >> 1;
    if ((xs[mid] ?? 0) < x) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  if (low > 0 && Math.abs((xs[low - 1] ?? 0) - x) <= Math.abs((xs[low] ?? 0) - x)) {
    return low - 1;
  }
  return low;
}

export function nearestMarker(markers: ChartMarker[], x: number, tolerance: number): number | null {
  const index = nearestIndex(
    markers.map((marker) => marker.x),
    x,
  );
  const marker = markers[index];
  if (!marker || Math.abs(marker.x - x) > tolerance) {
    return null;
  }
  return marker.change;
}

export function pickAt(geometry: ChartGeometry, x: number, tolerance = 12): ChartPick | null {
  const sample = nearestIndex(geometry.xs, x);
  if (sample < 0) {
    return null;
  }
  return {
    sample,
    marker: nearestMarker(geometry.markers, x, tolerance),
    samples: geometry.xs.length,
    markers: geometry.changeCount,
  };
}

export function timeTicks(geometry: ChartGeometry): ChartTick[] {
  const { startMs, endMs, plotLeft, plotRight } = geometry;
  if (!(endMs > startMs)) {
    return [];
  }
  const range = endMs - startMs;
  const first = DateTime.fromMillis(startMs, { zone: TIME_ZONE }).startOf('day');
  const instants: { at: DateTime; label: string }[] = [];
  if (range > 62 * DAY_MS) {
    for (let month = first.startOf('month'); month.toMillis() <= endMs; month = month.plus({ months: 1 })) {
      if ((month.month - 1) % 3 === 0) {
        instants.push({ at: month, label: month.month === 1 ? month.toFormat('yyyy') : month.toFormat('LLL') });
      }
    }
  }
  for (let day = first; range <= 62 * DAY_MS && day.toMillis() <= endMs; day = day.plus({ days: 1 })) {
    if (range <= 1.5 * DAY_MS) {
      for (const hour of [0, 6, 12, 18]) {
        const at = day.set({ hour });
        instants.push({ at, label: at.toFormat('h a') });
      }
    } else if (range <= 10 * DAY_MS) {
      instants.push({ at: day, label: day.toFormat('ccc') });
    } else if (day.weekday === 1) {
      instants.push({ at: day, label: day.toFormat('LLL d') });
    }
  }
  return instants
    .filter(({ at }) => at.toMillis() >= startMs && at.toMillis() <= endMs)
    .map(({ at, label }) => ({
      x: plotLeft + ((at.toMillis() - startMs) / range) * (plotRight - plotLeft),
      label,
    }));
}

export function formatMetric(metric: ChartMetric, value: number): string {
  if (metric === 'temperatureF') {
    return `${value.toFixed(1)}°`;
  }
  if (metric === 'humidity') {
    return `${Math.round(value)}%`;
  }
  return `${Math.round(value)} ppm`;
}

export function formatAxis(metric: ChartMetric, value: number): string {
  if (metric === 'temperatureF') {
    return `${value.toFixed(1)}°`;
  }
  if (metric === 'humidity') {
    return `${Math.round(value)}%`;
  }
  return `${Math.round(value)}`;
}

export function formatReadoutTime(iso: string, options: { withYear?: boolean; daily?: boolean } = {}): string {
  const instant = DateTime.fromISO(iso, { setZone: true }).setZone(TIME_ZONE);
  if (!instant.isValid) {
    return '';
  }
  const date = instant.toFormat(options.withYear || options.daily ? 'ccc, LLL d, yyyy' : 'ccc, LLL d');
  return options.daily ? date : `${date} · ${instant.toFormat('h:mm a')} ET`;
}

export function formatTooltipTime(iso: string, rangeMs: number, bucketSeconds = 0): string {
  const instant = DateTime.fromISO(iso, { setZone: true }).setZone(TIME_ZONE);
  if (!instant.isValid) {
    return '';
  }
  if (bucketSeconds >= DAY_MS / 1000) {
    return instant.toFormat('LLL d, yyyy');
  }
  if (rangeMs <= 1.5 * DAY_MS) {
    return instant.toFormat('h:mm a');
  }
  return rangeMs <= 10 * DAY_MS ? instant.toFormat('ccc h:mm a') : instant.toFormat('LLL d, h a');
}

export function bucketLabel(bucketSeconds: number): string {
  if (bucketSeconds <= 0) {
    return 'Reading';
  }
  if (bucketSeconds < 60 * 60) {
    return `${Math.round(bucketSeconds / 60)}-min average`;
  }
  const hours = bucketSeconds / (60 * 60);
  if (hours === 24) {
    return 'Daily average';
  }
  return hours === 1 ? '1-hour average' : `${Math.round(hours)}-hour average`;
}

export function describeChangeSource(change: SetpointChange, events: ScheduleEvent[]): string {
  const prefix = change.label.split(' · ')[0]?.trim() ?? '';
  if (change.source === 'sleep-now') {
    return 'Sleep now';
  }
  if (change.source === 'wake-now') {
    return 'Wake now';
  }
  if (change.source === 'run-now') {
    return prefix || 'Run now';
  }
  if (change.source === 'recalibrated') {
    return 'Recalibrated';
  }
  if (change.source === 'schedule') {
    const event = scheduleEventFor(change, events);
    return event ? `Schedule · ${event.label}` : 'Schedule';
  }
  if (prefix === 'Calibrated' || prefix === 'Recalibrated') {
    return prefix;
  }
  if (prefix && prefix !== 'Manual') {
    return `${prefix} preset`;
  }
  return 'Manual';
}

function scheduleEventFor(change: SetpointChange, events: ScheduleEvent[]): ScheduleEvent | null {
  const instant = DateTime.fromISO(change.at, { setZone: true }).setZone(TIME_ZONE);
  if (!instant.isValid) {
    return null;
  }
  const minuteOfDay = instant.hour * 60 + instant.minute;
  let best: { event: ScheduleEvent; late: number } | null = null;
  for (const event of events) {
    if (!event.enabled || event.targetF !== change.setpoint || !event.days.includes(instant.weekday)) {
      continue;
    }
    const late = minuteOfDay - (event.hour * 60 + event.minute);
    if (late < 0 || late > 30) {
      continue;
    }
    if (!best || late < best.late) {
      best = { event, late };
    }
  }
  return best?.event ?? null;
}

export type ChartFocus =
  | { kind: 'idle' }
  | { kind: 'scrubbing'; sample: number; marker: number | null }
  | { kind: 'pinned'; sample: number; marker: number | null };

export type ChartFocusEvent =
  | { type: 'scrub'; pick: ChartPick }
  | { type: 'tap'; pick: ChartPick }
  | { type: 'release' }
  | { type: 'dismiss' }
  | { type: 'data' };

export function idleFocus(): ChartFocus {
  return { kind: 'idle' };
}

function validPick(pick: ChartPick): boolean {
  const sampleOk = Number.isInteger(pick.sample) && pick.sample >= 0 && pick.sample < pick.samples;
  const markerOk = pick.marker === null || (Number.isInteger(pick.marker) && pick.marker >= 0 && pick.marker < pick.markers);
  return sampleOk && markerOk;
}

export function reduceChartFocus(focus: ChartFocus, event: ChartFocusEvent): ChartFocus {
  if (event.type === 'scrub') {
    if (!validPick(event.pick)) {
      return focus;
    }
    if (focus.kind === 'scrubbing' && focus.sample === event.pick.sample && focus.marker === event.pick.marker) {
      return focus;
    }
    return { kind: 'scrubbing', sample: event.pick.sample, marker: event.pick.marker };
  }
  if (event.type === 'tap') {
    if (!validPick(event.pick) || focus.kind === 'scrubbing') {
      return focus;
    }
    if (focus.kind === 'pinned' && focus.sample === event.pick.sample && focus.marker === event.pick.marker) {
      return { kind: 'idle' };
    }
    return { kind: 'pinned', sample: event.pick.sample, marker: event.pick.marker };
  }
  if (event.type === 'release') {
    return focus.kind === 'scrubbing' ? { kind: 'idle' } : focus;
  }
  if (event.type === 'dismiss') {
    return focus.kind === 'idle' ? focus : { kind: 'idle' };
  }
  return focus.kind === 'pinned' ? { kind: 'idle' } : focus;
}

export function focusWithin(focus: ChartFocus, samples: number, markers: number): ChartFocus {
  if (focus.kind === 'idle') {
    return focus;
  }
  if (focus.sample >= samples || (focus.marker !== null && focus.marker >= markers)) {
    return { kind: 'idle' };
  }
  return focus;
}

export function snappedMarker(previous: number | null, focus: ChartFocus): boolean {
  return focus.kind !== 'idle' && focus.marker !== null && focus.marker !== previous;
}

export function dataSignature(samples: HistorySample[], changes: SetpointChange[]): string {
  return [
    samples.length,
    samples[0]?.at ?? '',
    samples[samples.length - 1]?.at ?? '',
    changes.length,
    changes[changes.length - 1]?.at ?? '',
  ].join('|');
}
