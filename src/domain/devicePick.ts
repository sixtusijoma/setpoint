import { mapRejection } from './link';
import type { DeviceMap, DeviceRole } from '@/state/model';

export type ListedDevice = {
  deviceId: string;
  deviceName: string;
  deviceType: string;
  enableCloudService: boolean | null;
  hubDeviceId: string;
};

export type DeviceList =
  | { status: 'idle' }
  | { status: 'loading'; previous: ListedDevice[] }
  | { status: 'ready'; devices: ListedDevice[] }
  | { status: 'empty' }
  | { status: 'failed'; message: string };

export type DeviceListEvent =
  | { type: 'start' }
  | { type: 'loaded'; devices: ListedDevice[] }
  | { type: 'fail'; message: string }
  | { type: 'clear' };

export type DevicePick =
  | { status: 'idle' }
  | { status: 'choosing'; role: DeviceRole }
  | { status: 'rejected'; role: DeviceRole; message: string }
  | { status: 'assigned'; role: DeviceRole; deviceId: string };

export type DevicePickEvent =
  | { type: 'open'; role: DeviceRole }
  | { type: 'cancel' }
  | { type: 'choose'; device: { deviceId: string; deviceType: string; deviceName: string }; map: DeviceMap }
  | { type: 'clear' }
  | { type: 'dismiss' };

export function idleDeviceList(): DeviceList {
  return { status: 'idle' };
}

export function idleDevicePick(): DevicePick {
  return { status: 'idle' };
}

export function devicesOf(state: DeviceList): ListedDevice[] {
  if (state.status === 'ready') {
    return state.devices;
  }
  if (state.status === 'loading') {
    return state.previous;
  }
  return [];
}

export function reduceDeviceList(state: DeviceList, event: DeviceListEvent): DeviceList {
  if (event.type === 'start') {
    if (state.status === 'loading') {
      return state;
    }
    return { status: 'loading', previous: devicesOf(state) };
  }
  if (event.type === 'loaded') {
    if (state.status !== 'loading') {
      return state;
    }
    if (event.devices.length === 0) {
      return { status: 'empty' };
    }
    return { status: 'ready', devices: event.devices };
  }
  if (event.type === 'fail') {
    if (state.status !== 'loading') {
      return state;
    }
    return { status: 'failed', message: event.message };
  }
  if (event.type === 'clear') {
    if (state.status === 'idle') {
      return state;
    }
    return { status: 'idle' };
  }
  return state;
}

export function reduceDevicePick(state: DevicePick, event: DevicePickEvent): DevicePick {
  if (event.type === 'open') {
    return { status: 'choosing', role: event.role };
  }
  if (event.type === 'cancel') {
    if (state.status !== 'choosing') {
      return state;
    }
    return { status: 'idle' };
  }
  if (event.type === 'choose') {
    if (state.status !== 'choosing') {
      return state;
    }
    const rejection = mapRejection(state.role, event.device, event.map);
    if (rejection) {
      return { status: 'rejected', role: state.role, message: rejection };
    }
    return { status: 'assigned', role: state.role, deviceId: event.device.deviceId };
  }
  if (event.type === 'clear') {
    return { status: 'idle' };
  }
  if (event.type === 'dismiss') {
    if (state.status === 'rejected' || state.status === 'assigned') {
      return { status: 'idle' };
    }
    return state;
  }
  return state;
}

export function chooseDevice(
  map: DeviceMap,
  role: DeviceRole,
  device: { deviceId: string; deviceType: string; deviceName: string },
): DevicePick {
  const opened = reduceDevicePick(idleDevicePick(), { type: 'open', role });
  return reduceDevicePick(opened, { type: 'choose', device, map });
}
