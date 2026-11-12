import type { HistorySample, SetpointChange } from '@/domain/history';
import type { MeterImportSummary } from '@/domain/meterCsv';
import type { CommandSource } from '@/domain/pressSession';
import { defaultEvents, type HoldState, type RunRecord, type ScheduleEvent } from '@/domain/schedule';
import type { SchedulePhase } from '@/domain/scheduleRunner';
import { initialClimate, type ClimateState } from '@/devices/simulator';

export type { CommandSource };

export type Mode = 'demo' | 'live';

export type Settings = {
  step: number;
  delayMs: number;
  minF: number;
  maxF: number;
  pressCap: number;
  wakeFirst: boolean;
};

export type DeviceRef = {
  id: string;
  name: string;
  deviceType: string;
  enableCloudService: boolean | null;
  hubDeviceId: string;
};

export type DeviceMap = {
  up: DeviceRef | null;
  down: DeviceRef | null;
  meter: DeviceRef | null;
};

export type Preset = {
  id: string;
  label: string;
  tempF: number;
};

export type LogKind =
  | 'press'
  | 'wake'
  | 'schedule'
  | 'miss'
  | 'cancel'
  | 'failure'
  | 'calibration'
  | 'hold'
  | 'preset';

export type LogEntry = {
  id: string;
  at: string;
  kind: LogKind;
  message: string;
};

export type LiveReading = {
  temperatureF: number;
  humidity: number;
  co2Ppm: number;
  updatedAt: string;
  batteryUp: number | null;
  batteryDown: number | null;
  batteryMeter: number | null;
};

export type Persisted = {
  version: 1;
  virtualSetpoint: number | null;
  catchupFrom: string | null;
  mode: Mode;
  roomLabel: string;
  settings: Settings;
  deviceMap: DeviceMap;
  presets: Preset[];
  events: ScheduleEvent[];
  records: RunRecord[];
  hold: HoldState;
  log: LogEntry[];
  demoClimate: ClimateState;
  lastLive: LiveReading | null;
  catchupNote: string | null;
  schedulePhase: SchedulePhase;
  history: HistorySample[];
  changes: SetpointChange[];
};

export function createId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `id-${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
}

export function defaultPresets(): Preset[] {
  return [
    { id: 'sleep', label: 'Sleep', tempF: 61 },
    { id: 'wake', label: 'Wake', tempF: 70 },
    { id: 'away', label: 'Away', tempF: 62 },
    { id: 'home', label: 'Home', tempF: 72 },
  ];
}

export function createDefaultState(nowIso: string): Persisted {
  return {
    version: 1,
    virtualSetpoint: null,
    catchupFrom: null,
    mode: 'demo',
    roomLabel: 'Home',
    settings: {
      step: 1,
      delayMs: 1000,
      minF: 50,
      maxF: 85,
      pressCap: 15,
      wakeFirst: false,
    },
    deviceMap: { up: null, down: null, meter: null },
    presets: defaultPresets(),
    events: defaultEvents(),
    records: [],
    hold: null,
    log: [],
    demoClimate: initialClimate(nowIso),
    lastLive: null,
    catchupNote: null,
    schedulePhase: 'armed',
    history: [],
    changes: [],
  };
}

export function appendLog(state: Persisted, kind: LogKind, message: string, at: string): Persisted {
  const entry: LogEntry = { id: createId(), at, kind, message };
  return { ...state, log: [entry, ...state.log].slice(0, 200) };
}

export type AppAccess =
  | { status: 'unused' }
  | { status: 'locked' }
  | { status: 'checking' }
  | { status: 'unlocked' }
  | { status: 'wrong-key' };

export type AppAccessEvent =
  | { type: 'server-off' }
  | { type: 'no-key' }
  | { type: 'submit' }
  | { type: 'accepted' }
  | { type: 'rejected' }
  | { type: 'change' }
  | { type: 'clear' }
  | { type: 'unreachable' };

export function reduceAppAccess(access: AppAccess, event: AppAccessEvent): AppAccess {
  if (event.type === 'server-off') {
    return { status: 'unused' };
  }
  if (event.type === 'no-key') {
    return { status: 'locked' };
  }
  if (event.type === 'submit') {
    if (access.status === 'unused') {
      return access;
    }
    return { status: 'checking' };
  }
  if (event.type === 'accepted') {
    if (access.status === 'checking') {
      return { status: 'unlocked' };
    }
    return access;
  }
  if (event.type === 'rejected') {
    if (access.status === 'checking' || access.status === 'unlocked') {
      return { status: 'wrong-key' };
    }
    return access;
  }
  if (event.type === 'change') {
    if (access.status === 'unlocked' || access.status === 'wrong-key') {
      return { status: 'locked' };
    }
    return access;
  }
  if (event.type === 'clear') {
    if (access.status === 'unused') {
      return access;
    }
    return { status: 'locked' };
  }
  if (event.type === 'unreachable') {
    if (access.status === 'checking') {
      return { status: 'locked' };
    }
    return access;
  }
  return access;
}

export type MeterImportState =
  | { status: 'idle' }
  | { status: 'picking' }
  | { status: 'uploading' }
  | { status: 'done'; summary: MeterImportSummary }
  | { status: 'error'; message: string };

export type MeterImportEvent =
  | { type: 'pick' }
  | { type: 'cancel' }
  | { type: 'chosen' }
  | { type: 'succeed'; summary: MeterImportSummary }
  | { type: 'fail'; message: string }
  | { type: 'dismiss' };

export function idleMeterImport(): MeterImportState {
  return { status: 'idle' };
}

export function reduceMeterImport(state: MeterImportState, event: MeterImportEvent): MeterImportState {
  if (event.type === 'pick') {
    if (state.status === 'idle' || state.status === 'done' || state.status === 'error') {
      return { status: 'picking' };
    }
    return state;
  }
  if (event.type === 'cancel') {
    if (state.status === 'picking') {
      return { status: 'idle' };
    }
    return state;
  }
  if (event.type === 'chosen') {
    if (state.status === 'picking') {
      return { status: 'uploading' };
    }
    return state;
  }
  if (event.type === 'succeed') {
    if (state.status === 'uploading') {
      return { status: 'done', summary: event.summary };
    }
    return state;
  }
  if (event.type === 'fail') {
    if (state.status === 'picking' || state.status === 'uploading') {
      return { status: 'error', message: event.message };
    }
    return state;
  }
  if (event.type === 'dismiss') {
    if (state.status === 'done' || state.status === 'error') {
      return { status: 'idle' };
    }
    return state;
  }
  return state;
}

export function deviceFromApi(device: {
  deviceId: string;
  deviceName: string;
  deviceType: string;
  enableCloudService: boolean | null;
  hubDeviceId: string;
}): DeviceRef {
  return {
    id: device.deviceId,
    name: device.deviceName,
    deviceType: device.deviceType,
    enableCloudService: device.enableCloudService,
    hubDeviceId: device.hubDeviceId,
  };
}
