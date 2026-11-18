import { describe, expect, it } from 'vitest';

import {
  BATTERY_FRESH_MS,
  BATTERY_RETRY_MS,
  batteryReading,
  fetchFromReading,
  idleBatteryFetch,
  lowBatteries,
  lowBatterySentence,
  reduceBatteryFetch,
  shouldFetchBatteries,
  type BatteryReading,
} from './batteryFetch';

const reading: BatteryReading = {
  up: 80,
  down: 20,
  mode: 19,
  fetchedAt: '2026-11-18T12:00:00.000Z',
};

describe('battery fetch', () => {
  it('loads once, then keeps a fresh reading until the cache expires', () => {
    const loading = reduceBatteryFetch(idleBatteryFetch(), { type: 'start' });
    expect(loading.status).toBe('loading');
    expect(reduceBatteryFetch(loading, { type: 'start' })).toBe(loading);
    const fresh = reduceBatteryFetch(loading, { type: 'succeed', reading });
    expect(fresh).toEqual({ status: 'fresh', reading });
    expect(reduceBatteryFetch(fresh, { type: 'succeed', reading })).toBe(fresh);
    const at = Date.parse(reading.fetchedAt);
    expect(shouldFetchBatteries(fresh, at + BATTERY_FRESH_MS - 1)).toBe(false);
    expect(shouldFetchBatteries(fresh, at + BATTERY_FRESH_MS)).toBe(true);
    expect(shouldFetchBatteries(loading, at, true)).toBe(false);
  });

  it('keeps the last reading when a refresh fails and backs off', () => {
    const loading = reduceBatteryFetch({ status: 'fresh', reading }, { type: 'start' });
    const stale = reduceBatteryFetch(loading, { type: 'fail', error: 'offline', at: '2026-11-18T12:10:00.000Z' });
    expect(stale.status).toBe('stale');
    if (stale.status === 'stale') {
      expect(stale.reading).toEqual(reading);
      expect(shouldFetchBatteries(stale, Date.parse(stale.failedAt) + BATTERY_RETRY_MS - 1)).toBe(false);
      expect(shouldFetchBatteries(stale, Date.parse(stale.failedAt) + BATTERY_RETRY_MS)).toBe(true);
    }
    const failed = reduceBatteryFetch(idleBatteryFetch(), { type: 'start' });
    const error = reduceBatteryFetch(failed, { type: 'fail', error: 'offline', at: '2026-11-18T12:10:00.000Z' });
    expect(error.status).toBe('error');
    expect(batteryReading(error)).toBeNull();
  });

  it('warns at 20 percent and below for the three bots', () => {
    expect(lowBatteries(reading).map((item) => item.slot)).toEqual(['down', 'mode']);
    expect(lowBatteries({ up: 21, down: null, mode: 100 })).toEqual([]);
    expect(lowBatterySentence(reading)).toMatch(/Down bot 20%/);
    expect(lowBatterySentence({ up: 86, down: 74, mode: 91 })).toBeNull();
  });

  it('treats an old saved reading as stale', () => {
    const now = Date.parse(reading.fetchedAt) + BATTERY_FRESH_MS + 1;
    const stale = fetchFromReading(reading, now);
    expect(stale.status).toBe('stale');
    expect(fetchFromReading(null, now).status).toBe('idle');
    expect(fetchFromReading(reading, Date.parse(reading.fetchedAt)).status).toBe('fresh');
  });
});
