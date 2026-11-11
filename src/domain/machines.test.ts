import { describe, expect, it } from 'vitest';

import { initialClimate } from '@/devices/simulator';
import { deriveLink, mapRejection } from '@/domain/link';
import { reduceLifecycle } from '@/domain/lifecycle';
import { pushMessage } from '@/domain/messages';
import { deriveRoom } from '@/domain/room';
import { writeSetpoint } from '@/domain/setpoint';
import { downsampleReads } from '@/domain/history';
import { idleSession, reduceSession, type PressSession } from '@/domain/pressSession';
import type { DeviceRef } from '@/state/model';

const bot = (id: string, cloud: boolean | null = true): DeviceRef => ({
  id,
  name: id,
  deviceType: 'Bot',
  enableCloudService: cloud,
  hubDeviceId: 'hub',
});

describe('link, room, lifecycle, messages, setpoint', () => {
  it('derives one link value', () => {
    expect(deriveLink({ mode: 'demo', hasCredentials: false, serverConfigured: false, up: null, down: null, meter: null }).kind).toBe(
      'demo',
    );
    expect(
      deriveLink({ mode: 'live', hasCredentials: false, serverConfigured: false, up: null, down: null, meter: null }),
    ).toEqual({ kind: 'live', phase: 'needs-credentials' });
    const needsBots = deriveLink({
      mode: 'live',
      hasCredentials: true,
      serverConfigured: false,
      up: bot('up'),
      down: null,
      meter: null,
    });
    if (needsBots.kind === 'live') {
      expect(needsBots.phase).toBe('needs-bots');
    }
    const ready = deriveLink({
      mode: 'live',
      hasCredentials: false,
      serverConfigured: true,
      up: bot('up', false),
      down: bot('down', true),
      meter: { ...bot('meter'), deviceType: 'MeterPro(CO2)' },
    });
    expect(ready.kind).toBe('live');
    if (ready.kind === 'live' && ready.phase === 'ready') {
      expect(ready.cloud).toBe('off');
      expect(ready.meterId).toBe('meter');
    }
  });

  it('rejects a shared id and a meter mapped as a bot', () => {
    const map = { up: bot('up'), down: null, meter: null };
    expect(mapRejection('down', { deviceId: 'up', deviceType: 'Bot', deviceName: 'Up' }, map)).toMatch(/different/);
    expect(mapRejection('meter', { deviceId: 'm', deviceType: 'Bot', deviceName: 'Bot' }, map)).toMatch(/not a meter/);
    expect(mapRejection('up', { deviceId: 'm', deviceType: 'MeterPro(CO2)', deviceName: 'Meter' }, { up: null, down: null, meter: null })).toMatch(
      /not a bot/,
    );
  });

  it('keeps a meter reading when the refresh fails after one exists', () => {
    const climate = initialClimate('2026-11-11T00:00:00.000Z');
    const reading = {
      temperatureF: 68,
      humidity: 40,
      co2Ppm: 700,
      updatedAt: '2026-11-11T00:00:00.000Z',
      batteryUp: 80,
      batteryDown: 80,
      batteryMeter: 80,
    };
    const loading = deriveRoom({ mode: 'live', climate, lastLive: null, refreshing: true, error: null });
    const unread = deriveRoom({ mode: 'live', climate, lastLive: null, refreshing: false, error: null });
    const stale = deriveRoom({ mode: 'live', climate, lastLive: reading, refreshing: false, error: 'battery failed' });
    if (loading.kind === 'live') {
      expect(loading.phase).toBe('loading');
    }
    if (unread.kind === 'live') {
      expect(unread.phase).toBe('unread');
    }
    if (stale.kind === 'live') {
      expect(stale.phase).toBe('stale');
    }
  });

  it('pauses on background and does not boot twice', () => {
    expect(reduceLifecycle({ kind: 'boot' }, 'booted')).toEqual({ kind: 'active' });
    expect(reduceLifecycle({ kind: 'active' }, 'background')).toEqual({ kind: 'paused', press: 'none' });
    expect(reduceLifecycle({ kind: 'paused', press: 'none' }, 'press-interrupted')).toEqual({
      kind: 'paused',
      press: 'interrupted',
    });
    expect(reduceLifecycle({ kind: 'paused', press: 'interrupted' }, 'foreground')).toEqual({ kind: 'active' });
    expect(reduceLifecycle({ kind: 'active' }, 'booted')).toEqual({ kind: 'active' });
  });

  it('does not let a meter error replace a press message', () => {
    const press = { source: 'press' as const, text: 'Stopped at 71°.' };
    expect(pushMessage(press, { source: 'meter', text: 'Meter failed.' })).toEqual(press);
    expect(pushMessage({ source: 'meter', text: 'Meter failed.' }, press)).toEqual(press);
    expect(pushMessage(press, null)).toBeNull();
  });

  it('refuses setpoint writes from outside a running session', () => {
    const running = reduceSession(idleSession(), {
      type: 'start',
      target: 72,
      startedFrom: 70,
      actions: [{ kind: 'adjust', direction: 'up', setpointAfter: 71 }],
      source: { kind: 'manual' },
      mode: 'demo',
    });
    expect(writeSetpoint(70, { degrees: 66, source: 'recalibrated' }, running).ok).toBe(false);
    expect(writeSetpoint(70, { degrees: 71, source: 'press' }, running)).toEqual({ ok: true, degrees: 71 });
    const idle: PressSession = { phase: 'idle' };
    expect(writeSetpoint(null, { degrees: 70, source: 'calibrated' }, idle)).toEqual({ ok: true, degrees: 70 });
  });

  it('rolls raw reads older than the retention window into hours', () => {
    const now = new Date('2026-11-11T12:00:00.000Z');
    const old = new Date('2026-09-01T15:10:00.000Z').toISOString();
    const older = new Date('2026-09-01T15:40:00.000Z').toISOString();
    const recent = new Date('2026-11-10T12:00:00.000Z').toISOString();
    const rolled = downsampleReads(
      [
        { at: old, temperatureF: 60, humidity: 40, co2Ppm: 700 },
        { at: older, temperatureF: 62, humidity: 42, co2Ppm: 800 },
        { at: recent, temperatureF: 68, humidity: 47, co2Ppm: 740 },
      ],
      now,
      30,
    );
    expect(rolled.keep).toHaveLength(1);
    expect(rolled.hourly).toHaveLength(1);
    expect(rolled.hourly[0]?.temperatureF).toBe(61);
    expect(rolled.hourly[0]?.co2Ppm).toBe(750);
  });
});
