import type { DeviceRef, Mode } from '@/state/model';

export type CloudFlag = 'on' | 'off' | 'unknown';

export type Link =
  | { kind: 'demo' }
  | { kind: 'live'; phase: 'needs-credentials' }
  | { kind: 'live'; phase: 'needs-bots' }
  | {
      kind: 'live';
      phase: 'ready';
      upId: string;
      downId: string;
      meterId: string | null;
      cloud: CloudFlag;
    };

export function cloudFlag(up: DeviceRef | null, down: DeviceRef | null): CloudFlag {
  const flags = [up?.enableCloudService, down?.enableCloudService];
  if (flags.some((flag) => flag === false)) {
    return 'off';
  }
  if (flags.some((flag) => flag === true)) {
    return 'on';
  }
  return 'unknown';
}

export function deriveLink(input: {
  mode: Mode;
  hasCredentials: boolean;
  serverConfigured: boolean;
  up: DeviceRef | null;
  down: DeviceRef | null;
  meter: DeviceRef | null;
}): Link {
  if (input.mode === 'demo') {
    return { kind: 'demo' };
  }
  const credsReady = input.hasCredentials || input.serverConfigured;
  if (!credsReady) {
    return { kind: 'live', phase: 'needs-credentials' };
  }
  if (!input.up || !input.down) {
    return { kind: 'live', phase: 'needs-bots' };
  }
  return {
    kind: 'live',
    phase: 'ready',
    upId: input.up.id,
    downId: input.down.id,
    meterId: input.meter?.id ?? null,
    cloud: cloudFlag(input.up, input.down),
  };
}

export function isMeterType(deviceType: string): boolean {
  return /meter/i.test(deviceType);
}

export function isBotType(deviceType: string): boolean {
  return /bot/i.test(deviceType);
}

export function mapRejection(
  role: 'up' | 'down' | 'meter',
  device: { deviceId: string; deviceType: string; deviceName: string },
  map: { up: DeviceRef | null; down: DeviceRef | null; meter: DeviceRef | null },
): string | null {
  if (role === 'meter') {
    if (!isMeterType(device.deviceType)) {
      return `${device.deviceName} is not a meter. Choose the Meter Pro for the room reading.`;
    }
  } else if (!isBotType(device.deviceType)) {
    return `${device.deviceName} is not a bot. Up and down need two different SwitchBot Bots.`;
  }
  const otherIds = (['up', 'down', 'meter'] as const)
    .filter((item) => item !== role)
    .map((item) => map[item]?.id)
    .filter((id): id is string => Boolean(id));
  if (otherIds.includes(device.deviceId)) {
    return 'Up, down, and the meter have to be three different devices.';
  }
  return null;
}
