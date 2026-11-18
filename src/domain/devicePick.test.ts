import { describe, expect, it } from 'vitest';

import type { DeviceMap } from '@/state/model';
import {
  chooseDevice,
  devicesOf,
  idleDeviceList,
  idleDevicePick,
  reduceDeviceList,
  reduceDevicePick,
} from './devicePick';

const emptyMap = (): DeviceMap => ({ up: null, down: null, meter: null, mode: null });

const bot = (id: string) => ({
  deviceId: id,
  deviceName: id,
  deviceType: 'Bot',
});

describe('device list and pick', () => {
  it('loads a list once and ignores a result that arrives after idle', () => {
    const loading = reduceDeviceList(idleDeviceList(), { type: 'start' });
    expect(reduceDeviceList(loading, { type: 'start' })).toBe(loading);
    const ready = reduceDeviceList(loading, { type: 'loaded', devices: [{ ...bot('up'), enableCloudService: true, hubDeviceId: 'hub' }] });
    expect(ready.status).toBe('ready');
    expect(devicesOf(ready)).toHaveLength(1);
    const again = reduceDeviceList(ready, { type: 'start' });
    expect(again.status).toBe('loading');
    if (again.status === 'loading') {
      expect(again.previous).toHaveLength(1);
    }
    expect(reduceDeviceList(idleDeviceList(), { type: 'loaded', devices: [] })).toEqual(idleDeviceList());
    expect(reduceDeviceList(idleDeviceList(), { type: 'fail', message: 'nope' })).toEqual(idleDeviceList());
    const empty = reduceDeviceList(loading, { type: 'loaded', devices: [] });
    expect(empty.status).toBe('empty');
  });

  it('assigns a mode bot only from the choosing state and rejects a shared id', () => {
    const map = emptyMap();
    expect(reduceDevicePick(idleDevicePick(), { type: 'choose', device: bot('mode'), map })).toEqual(idleDevicePick());
    const chosen = chooseDevice(map, 'mode', bot('mode'));
    expect(chosen).toEqual({ status: 'assigned', role: 'mode', deviceId: 'mode' });
    const taken = {
      ...map,
      up: { id: 'up', name: 'up', deviceType: 'Bot', enableCloudService: true, hubDeviceId: 'hub' },
    };
    const rejected = chooseDevice(taken, 'mode', bot('up'));
    expect(rejected.status).toBe('rejected');
    if (rejected.status === 'rejected') {
      expect(rejected.message).toMatch(/different/);
    }
    const meter = chooseDevice(map, 'mode', { deviceId: 'm', deviceName: 'Meter', deviceType: 'MeterPro(CO2)' });
    expect(meter.status).toBe('rejected');
    expect(reduceDevicePick(rejected, { type: 'cancel' })).toEqual(rejected);
    expect(reduceDevicePick(rejected, { type: 'dismiss' })).toEqual(idleDevicePick());
  });
});
