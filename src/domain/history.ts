export type HistorySample = {
  at: string;
  temperatureF: number;
  humidity: number;
  co2Ppm: number;
};

export type SetpointChange = {
  at: string;
  setpoint: number;
  source: string;
  label: string;
};

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export const LOCAL_HISTORY_CAP = 20000;

export type HistorySpan = 'day' | 'week' | 'month';

export type HistoryQuery = {
  since: string;
  until: string;
  bucketSeconds: number;
};

export function spanWindowMs(span: HistorySpan): number {
  if (span === 'day') {
    return DAY_MS;
  }
  if (span === 'week') {
    return 7 * DAY_MS;
  }
  return 30 * DAY_MS;
}

export function bucketSecondsForRange(windowMs: number): number {
  if (windowMs <= DAY_MS) {
    return 5 * 60;
  }
  if (windowMs <= 7 * DAY_MS) {
    return 30 * 60;
  }
  if (windowMs <= 31 * DAY_MS) {
    return 2 * 60 * 60;
  }
  if (windowMs <= 120 * DAY_MS) {
    return 6 * 60 * 60;
  }
  return 24 * 60 * 60;
}

export function historyQuery(input: { span?: unknown; since?: unknown; until?: unknown }, now: Date): HistoryQuery {
  if (typeof input.since === 'string' || typeof input.until === 'string') {
    if (typeof input.since !== 'string' || typeof input.until !== 'string') {
      throw new Error('Pass both since and until.');
    }
    const sinceMs = Date.parse(input.since);
    const untilMs = Date.parse(input.until);
    if (!Number.isFinite(sinceMs) || !Number.isFinite(untilMs)) {
      throw new Error('since and until must be ISO timestamps.');
    }
    if (sinceMs > untilMs) {
      throw new Error('since must be before until.');
    }
    const windowMs = untilMs - sinceMs;
    if (windowMs > 800 * DAY_MS) {
      throw new Error('Choose a range of 800 days or less.');
    }
    return {
      since: new Date(sinceMs).toISOString(),
      until: new Date(untilMs).toISOString(),
      bucketSeconds: bucketSecondsForRange(windowMs),
    };
  }
  const span: HistorySpan = input.span === 'week' ? 'week' : input.span === 'month' ? 'month' : 'day';
  const windowMs = spanWindowMs(span);
  return {
    since: new Date(now.getTime() - windowMs).toISOString(),
    until: new Date(now.getTime() + 1000).toISOString(),
    bucketSeconds: bucketSecondsForRange(windowMs),
  };
}

export function sliceWindow(samples: HistorySample[], now: Date, span: HistorySpan): HistorySample[] {
  const start = now.getTime() - spanWindowMs(span);
  return samples
    .filter((sample) => {
      const time = Date.parse(sample.at);
      return Number.isFinite(time) && time >= start && time <= now.getTime() + 1000;
    })
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

export function changesInWindow(changes: SetpointChange[], now: Date, span: HistorySpan): SetpointChange[] {
  const start = now.getTime() - spanWindowMs(span);
  return changes
    .filter((change) => {
      const time = Date.parse(change.at);
      return Number.isFinite(time) && time >= start && time <= now.getTime() + 1000;
    })
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

export function downsampleReads<T extends HistorySample & { granularity?: 'raw' | 'hour' }>(
  reads: T[],
  now: Date,
  retainDays = 30,
): { keep: T[]; hourly: T[] } {
  const cutoff = now.getTime() - retainDays * DAY_MS;
  const keep: T[] = [];
  const buckets = new Map<number, T[]>();
  for (const read of reads) {
    const time = Date.parse(read.at);
    if (!Number.isFinite(time)) {
      continue;
    }
    if (read.granularity === 'hour' || time >= cutoff) {
      keep.push(read);
      continue;
    }
    const bucket = Math.floor(time / HOUR_MS) * HOUR_MS;
    const list = buckets.get(bucket) ?? [];
    list.push(read);
    buckets.set(bucket, list);
  }
  const hourly: T[] = [];
  for (const [bucket, list] of buckets) {
    const temperatureF = average(list.map((item) => item.temperatureF));
    const humidity = average(list.map((item) => item.humidity));
    const co2Ppm = Math.round(average(list.map((item) => item.co2Ppm)));
    hourly.push({
      ...list[0],
      at: new Date(bucket).toISOString(),
      temperatureF,
      humidity,
      co2Ppm,
      granularity: 'hour',
    });
  }
  hourly.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return { keep, hourly };
}

export function aggregateSamples(samples: HistorySample[], bucketSeconds: number): HistorySample[] {
  if (bucketSeconds <= 0) {
    return samples;
  }
  const bucketMs = bucketSeconds * 1000;
  const groups = new Map<number, HistorySample[]>();
  for (const sample of samples) {
    const time = Date.parse(sample.at);
    if (!Number.isFinite(time)) {
      continue;
    }
    const bucket = Math.floor(time / bucketMs) * bucketMs;
    const list = groups.get(bucket);
    if (list) {
      list.push(sample);
    } else {
      groups.set(bucket, [sample]);
    }
  }
  const aggregated: HistorySample[] = [];
  for (const [bucket, list] of groups) {
    const co2Total = list.reduce((sum, item) => sum + item.co2Ppm, 0);
    aggregated.push({
      at: new Date(bucket).toISOString(),
      temperatureF: average(list.map((item) => item.temperatureF)),
      humidity: average(list.map((item) => item.humidity)),
      co2Ppm: Math.round(co2Total / list.length),
    });
  }
  aggregated.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return aggregated;
}

function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const total = values.reduce((sum, value) => sum + value, 0);
  return Math.round((total / values.length) * 10) / 10;
}

export function seedDemoHistory(now: Date): { history: HistorySample[]; changes: SetpointChange[] } {
  const history: HistorySample[] = [];
  const changes: SetpointChange[] = [];
  const end = now.getTime();
  for (let index = 24 * 32; index >= 0; index -= 1) {
    const at = new Date(end - index * HOUR_MS);
    const hour = at.getUTCHours();
    const wave = Math.sin((index / 24) * Math.PI * 2);
    history.push({
      at: at.toISOString(),
      temperatureF: Math.round((68 + wave * 3) * 10) / 10,
      humidity: Math.round(47 + wave * 6),
      co2Ppm: Math.round(760 + (hour % 5) * 40 + wave * 80),
    });
  }
  for (let day = 13; day >= 0; day -= 1) {
    const morning = new Date(end - day * DAY_MS);
    morning.setUTCHours(11, 45, 0, 0);
    const night = new Date(end - day * DAY_MS);
    night.setUTCHours(4, 45, 0, 0);
    if (morning.getTime() <= end) {
      changes.push({ at: morning.toISOString(), setpoint: 70, source: 'schedule', label: 'Wake' });
    }
    if (night.getTime() <= end && night.getUTCDay() !== 0 && night.getUTCDay() !== 6) {
      changes.push({ at: night.toISOString(), setpoint: 61, source: 'schedule', label: 'Sleep' });
    }
  }
  changes.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return { history, changes };
}
