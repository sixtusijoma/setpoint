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

export function sliceWindow(samples: HistorySample[], now: Date, span: 'day' | 'week'): HistorySample[] {
  const windowMs = span === 'day' ? DAY_MS : 7 * DAY_MS;
  const start = now.getTime() - windowMs;
  return samples
    .filter((sample) => {
      const time = Date.parse(sample.at);
      return Number.isFinite(time) && time >= start && time <= now.getTime() + 1000;
    })
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

export function changesInWindow(changes: SetpointChange[], now: Date, span: 'day' | 'week'): SetpointChange[] {
  const windowMs = span === 'day' ? DAY_MS : 7 * DAY_MS;
  const start = now.getTime() - windowMs;
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
  for (let index = 24 * 7; index >= 0; index -= 1) {
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
  for (let day = 6; day >= 0; day -= 1) {
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
