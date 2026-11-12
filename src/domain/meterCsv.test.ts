import { describe, expect, it } from 'vitest';

import { aggregateSamples, bucketSecondsForRange, historyQuery, sliceWindow } from './history';
import { mergeMeterHistory, parseMeterCsv, parseMeterTimestamp } from './meterCsv';

const CELSIUS = [
  'Timestamp,Temperature_Celsius(°C),Relative_Humidity(%),CO2(ppm),Absolute_Humidity(g/m3),DPT_Celsius(°C),VPD(kPa)',
  '2026-04-21 13:39:04,25.9,44,677,10.5,13.2,1.14',
  '2026-04-21 13:40:04,26.0,45,680,10.6,13.3,1.15',
  'not-a-time,20,40,600,1,1,1',
  '2026-04-21 13:41:04,25.0,140,600,1,1,1',
  '',
].join('\n');

const FAHRENHEIT = [
  'Timestamp,Temperature_Fahrenheit(°F),Relative_Humidity(%),CO2(ppm)',
  '2026-04-21 1:39:04 PM,78.6,44,677',
].join('\n');

const SLASH = ['Date,temperature,humidity,CO2(ppm)', '2022/8/27 0:00,24.4,76,640', '2022/8/27 0:00,24.4,76,640'].join('\n');

describe('meter csv', () => {
  it('parses the Celsius export with seconds and ignores extra columns', () => {
    const parsed = parseMeterCsv(CELSIUS);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.skipped).toBe(2);
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0]).toEqual({
      at: '2026-04-21T17:39:04.000Z',
      temperatureF: 78.6,
      humidity: 44,
      co2Ppm: 677,
    });
  });

  it('parses a Fahrenheit header and a 12 hour clock', () => {
    const parsed = parseMeterCsv(FAHRENHEIT);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.rows[0]).toMatchObject({
      at: '2026-04-21T17:39:04.000Z',
      temperatureF: 78.6,
      humidity: 44,
      co2Ppm: 677,
    });
  });

  it('parses the slash timestamp and a bare temperature header as Celsius', () => {
    const parsed = parseMeterCsv(SLASH);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.skipped).toBe(0);
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0]?.at).toBe('2022-08-27T04:00:00.000Z');
    expect(parsed.rows[0]?.temperatureF).toBe(75.9);
  });

  it('accepts a Japanese meridian and a compact Fahrenheit header', () => {
    expect(parseMeterTimestamp('2026-04-21 午後 1:39:04')).toBe('2026-04-21T17:39:04.000Z');
    expect(parseMeterTimestamp('2026-11-11 6:51:00 PM')).toBe('2026-11-11T23:51:00.000Z');
    const parsed = parseMeterCsv('Time,Temperature(°F),Humidity(%),CO2\n2026-11-11 6:51 PM,70,47,740\n');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.rows[0]).toMatchObject({ at: '2026-11-11T23:51:00.000Z', temperatureF: 70, co2Ppm: 740 });
  });

  it('rejects a file without a CO2 column', () => {
    const parsed = parseMeterCsv('Date,temperature,humidity\n2022/8/27 0:00,24.4,76\n');
    expect(parsed.ok).toBe(false);
  });

  it('is idempotent against readings that are already stored', () => {
    const parsed = parseMeterCsv(SLASH);
    if (!parsed.ok) {
      throw new Error('expected rows');
    }
    const first = mergeMeterHistory([], parsed.rows, parsed.skipped);
    expect(first.summary).toMatchObject({ inserted: 1, duplicates: 1, skipped: 0 });
    const second = mergeMeterHistory(first.history, parsed.rows, parsed.skipped);
    expect(second.summary).toMatchObject({ inserted: 0, duplicates: 2, skipped: 0 });
    expect(second.history).toHaveLength(1);
    expect(second.summary.firstAt).toBe('2022-08-27T04:00:00.000Z');
    expect(second.summary.lastAt).toBe('2022-08-27T04:00:00.000Z');
  });
});

describe('history ranges', () => {
  const now = new Date('2026-11-12T16:00:00.000Z');
  const samples = [
    { at: '2026-11-12T14:00:00.000Z', temperatureF: 70, humidity: 40, co2Ppm: 111 },
    { at: '2026-11-09T16:00:00.000Z', temperatureF: 71, humidity: 41, co2Ppm: 222 },
    { at: '2026-10-23T16:00:00.000Z', temperatureF: 72, humidity: 42, co2Ppm: 333 },
    { at: '2026-10-03T16:00:00.000Z', temperatureF: 73, humidity: 43, co2Ppm: 444 },
  ];

  it('keeps a day, a week, and a month', () => {
    expect(sliceWindow(samples, now, 'day').map((sample) => sample.co2Ppm)).toEqual([111]);
    expect(sliceWindow(samples, now, 'week').map((sample) => sample.co2Ppm)).toEqual([222, 111]);
    expect(sliceWindow(samples, now, 'month').map((sample) => sample.co2Ppm)).toEqual([333, 222, 111]);
  });

  it('builds a custom range and buckets long windows', () => {
    const custom = historyQuery({ since: '2026-10-01T00:00:00.000Z', until: '2026-10-10T00:00:00.000Z' }, now);
    expect(custom.since).toBe('2026-10-01T00:00:00.000Z');
    expect(custom.until).toBe('2026-10-10T00:00:00.000Z');
    expect(Date.parse(custom.until) - Date.parse(custom.since)).toBeLessThanOrEqual(31 * 24 * 60 * 60 * 1000);
    expect(bucketSecondsForRange(24 * 60 * 60 * 1000)).toBe(300);
    expect(bucketSecondsForRange(7 * 24 * 60 * 60 * 1000)).toBe(1800);
    expect(bucketSecondsForRange(30 * 24 * 60 * 60 * 1000)).toBe(7200);
    expect(() => historyQuery({ since: '2026-10-01T00:00:00.000Z' }, now)).toThrow(/both/);
    const month = historyQuery({ span: 'month' }, now);
    expect(Date.parse(month.until) - Date.parse(month.since)).toBeGreaterThan(29 * 24 * 60 * 60 * 1000);
  });

  it('averages samples that fall in one bucket', () => {
    const bucket = aggregateSamples(
      [
        { at: '2026-11-12T14:01:00.000Z', temperatureF: 70, humidity: 40, co2Ppm: 600 },
        { at: '2026-11-12T14:04:00.000Z', temperatureF: 72, humidity: 50, co2Ppm: 700 },
      ],
      300,
    );
    expect(bucket).toHaveLength(1);
    expect(bucket[0]).toMatchObject({ temperatureF: 71, humidity: 45, co2Ppm: 650 });
  });
});
