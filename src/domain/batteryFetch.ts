export const BATTERY_FRESH_MS = 10 * 60 * 1000;
export const BATTERY_RETRY_MS = 60 * 1000;
export const LOW_BATTERY_AT = 20;

export type BotSlot = 'up' | 'down' | 'mode';

export type BatteryReading = {
  up: number | null;
  down: number | null;
  mode: number | null;
  fetchedAt: string;
  failedAt?: string;
};

export type BatteryFetch =
  | { status: 'idle' }
  | { status: 'loading'; previous: BatteryReading | null }
  | { status: 'fresh'; reading: BatteryReading }
  | { status: 'stale'; reading: BatteryReading; error: string; failedAt: string }
  | { status: 'error'; error: string; previous: BatteryReading | null; failedAt: string };

export type BatteryEvent =
  | { type: 'start' }
  | { type: 'succeed'; reading: BatteryReading }
  | { type: 'fail'; error: string; at: string };

const SLOT_LABEL: Record<BotSlot, string> = {
  up: 'Up bot',
  down: 'Down bot',
  mode: 'Mode bot',
};

export function idleBatteryFetch(): BatteryFetch {
  return { status: 'idle' };
}

export function batteryReading(state: BatteryFetch): BatteryReading | null {
  if (state.status === 'fresh' || state.status === 'stale') {
    return state.reading;
  }
  if (state.status === 'loading' || state.status === 'error') {
    return state.previous;
  }
  return null;
}

export function reduceBatteryFetch(state: BatteryFetch, event: BatteryEvent): BatteryFetch {
  if (event.type === 'start') {
    if (state.status === 'loading') {
      return state;
    }
    return { status: 'loading', previous: batteryReading(state) };
  }
  if (event.type === 'succeed') {
    if (state.status !== 'loading') {
      return state;
    }
    return { status: 'fresh', reading: event.reading };
  }
  if (event.type === 'fail') {
    if (state.status !== 'loading') {
      return state;
    }
    if (state.previous) {
      return { status: 'stale', reading: state.previous, error: event.error, failedAt: event.at };
    }
    return { status: 'error', error: event.error, previous: null, failedAt: event.at };
  }
  return state;
}

export function shouldFetchBatteries(state: BatteryFetch, nowMs: number, force = false): boolean {
  if (state.status === 'loading') {
    return false;
  }
  if (force) {
    return true;
  }
  if (state.status === 'idle') {
    return true;
  }
  if (state.status === 'fresh') {
    return nowMs - Date.parse(state.reading.fetchedAt) >= BATTERY_FRESH_MS;
  }
  const failedAt = Date.parse(state.failedAt);
  return nowMs - failedAt >= BATTERY_RETRY_MS;
}

export function stateFromCache(cache: BatteryReading | null, nowMs: number): BatteryFetch {
  if (!cache) {
    return { status: 'idle' };
  }
  if (cache.failedAt) {
    return { status: 'stale', reading: cache, error: 'The last battery read failed.', failedAt: cache.failedAt };
  }
  return fetchFromReading(cache, nowMs);
}

export function fetchFromReading(reading: BatteryReading | null, nowMs: number): BatteryFetch {
  if (!reading) {
    return { status: 'idle' };
  }
  const fresh: BatteryFetch = { status: 'fresh', reading };
  if (shouldFetchBatteries(fresh, nowMs)) {
    return { status: 'stale', reading, error: 'Battery cache expired.', failedAt: reading.fetchedAt };
  }
  return fresh;
}

export function lowBatteries(reading: {
  up: number | null;
  down: number | null;
  mode: number | null;
}): { slot: BotSlot; percent: number }[] {
  const slots: BotSlot[] = ['up', 'down', 'mode'];
  const low: { slot: BotSlot; percent: number }[] = [];
  for (const slot of slots) {
    const percent = reading[slot];
    if (typeof percent === 'number' && percent <= LOW_BATTERY_AT) {
      low.push({ slot, percent });
    }
  }
  return low;
}

export function displayBatteries(input: {
  mode: 'demo' | 'live';
  demoClimate: { batteryUp: number | null; batteryDown: number | null; batteryMode: number | null; updatedAt: string };
  batteryCache: BatteryReading | null;
  lastLive: { batteryUp: number | null; batteryDown: number | null; batteryMode: number | null; updatedAt: string } | null;
}): BatteryReading {
  if (input.mode === 'demo') {
    return {
      up: input.demoClimate.batteryUp,
      down: input.demoClimate.batteryDown,
      mode: input.demoClimate.batteryMode,
      fetchedAt: input.demoClimate.updatedAt,
    };
  }
  if (input.batteryCache) {
    return input.batteryCache;
  }
  return {
    up: input.lastLive?.batteryUp ?? null,
    down: input.lastLive?.batteryDown ?? null,
    mode: input.lastLive?.batteryMode ?? null,
    fetchedAt: input.lastLive?.updatedAt ?? new Date(0).toISOString(),
  };
}

export function lowBatterySentence(reading: {
  up: number | null;
  down: number | null;
  mode: number | null;
} | null): string | null {
  if (!reading) {
    return null;
  }
  const lows = lowBatteries(reading);
  if (lows.length === 0) {
    return null;
  }
  if (lows.length === 1) {
    const item = lows[0];
    return `${SLOT_LABEL[item.slot]} battery is ${Math.round(item.percent)}%. Replace it soon.`;
  }
  const list = lows.map((item) => `${SLOT_LABEL[item.slot]} ${Math.round(item.percent)}%`).join(', ');
  return `Low batteries: ${list}. Replace them soon.`;
}
