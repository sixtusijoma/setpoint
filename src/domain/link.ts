import type { DeviceMap, DeviceRef, DeviceRole, Mode } from '@/state/model';

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
  role: DeviceRole,
  device: { deviceId: string; deviceType: string; deviceName: string },
  map: DeviceMap,
): string | null {
  if (role === 'meter') {
    if (!isMeterType(device.deviceType)) {
      return `${device.deviceName} is not a meter. Choose the Meter Pro for the room reading.`;
    }
  } else if (!isBotType(device.deviceType)) {
    return role === 'mode'
      ? `${device.deviceName} is not a bot. The mode control needs a SwitchBot Bot.`
      : `${device.deviceName} is not a bot. Up, down, and mode need SwitchBot Bots.`;
  }
  const otherIds = (['up', 'down', 'mode', 'meter'] as const)
    .filter((item) => item !== role)
    .map((item) => map[item]?.id)
    .filter((id): id is string => Boolean(id));
  if (otherIds.includes(device.deviceId)) {
    return 'Up, down, mode, and the meter have to be four different devices.';
  }
  return null;
}
