import AsyncStorage from '@react-native-async-storage/async-storage';

import { defaultEvents, type HoldState, type ScheduleEvent } from '@/domain/schedule';
import { initialClimate } from '@/devices/simulator';
import {
  createDefaultState,
  defaultPresets,
  type DeviceRef,
  type Persisted,
  type Preset,
} from '@/state/model';

const KEY = 'setpoint.state.v1';

export async function loadPersisted(nowIso: string): Promise<Persisted | null> {
  const raw = await AsyncStorage.getItem(KEY);
  if (!raw) {
    return null;
  }
  try {
    return sanitizeState(JSON.parse(raw), nowIso);
  } catch {
    return null;
  }
}

export async function savePersisted(state: Persisted): Promise<void> {
  await AsyncStorage.setItem(KEY, JSON.stringify(state));
}

function sanitizeState(raw: unknown, nowIso: string): Persisted | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const record = raw as Partial<Persisted>;
  if (record.version !== 1) {
    return null;
  }
  const base = createDefaultState(nowIso);
  const settings = { ...base.settings, ...(record.settings ?? {}) };
  const minF = clampInt(settings.minF, 40, 80, 50);
  let maxF = clampInt(settings.maxF, 50, 99, 85);
  if (maxF <= minF) {
    maxF = Math.min(99, minF + 1);
  }
  return {
    ...base,
    virtualSetpoint: typeof record.virtualSetpoint === 'number' ? Math.round(record.virtualSetpoint) : null,
    catchupFrom: typeof record.catchupFrom === 'string' ? record.catchupFrom : null,
    mode: record.mode === 'live' ? 'live' : 'demo',
    roomLabel: typeof record.roomLabel === 'string' && record.roomLabel.trim() ? record.roomLabel.trim() : 'Home',
    settings: {
      step: clampInt(settings.step, 1, 5, 1),
      delayMs: clampInt(settings.delayMs, 200, 10000, 1000),
      minF,
      maxF,
      pressCap: clampInt(settings.pressCap, 1, 40, 15),
      wakeFirst: Boolean(settings.wakeFirst),
    },
    deviceMap: {
      up: cleanDevice(record.deviceMap?.up),
      down: cleanDevice(record.deviceMap?.down),
      meter: cleanDevice(record.deviceMap?.meter),
    },
    presets: cleanPresets(record.presets, defaultPresets()),
    events: cleanEvents(record.events),
    records: Array.isArray(record.records) ? record.records.slice(-400) : [],
    hold: cleanHold(record.hold),
    log: Array.isArray(record.log) ? record.log.slice(0, 200) : [],
    demoClimate: { ...initialClimate(nowIso), ...(record.demoClimate ?? {}) },
    lastLive: record.lastLive && typeof record.lastLive.temperatureF === 'number' ? record.lastLive : null,
  };
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  const rounded = Math.round(value);
  if (rounded < min) {
    return min;
  }
  if (rounded > max) {
    return max;
  }
  return rounded;
}

function cleanDevice(value: DeviceRef | null | undefined): DeviceRef | null {
  if (!value || typeof value.id !== 'string' || !value.id) {
    return null;
  }
  return {
    id: value.id,
    name: value.name || 'Device',
    deviceType: value.deviceType || 'Unknown',
    enableCloudService: typeof value.enableCloudService === 'boolean' ? value.enableCloudService : null,
    hubDeviceId: value.hubDeviceId || '',
  };
}

function cleanPresets(value: Preset[] | undefined, fallback: Preset[]): Preset[] {
  if (!Array.isArray(value) || value.length === 0) {
    return fallback;
  }
  const presets = value.filter((preset) => preset && typeof preset.id === 'string' && typeof preset.tempF === 'number');
  if (presets.length === 0) {
    return fallback;
  }
  return presets.map((preset) => ({
    id: preset.id,
    label: preset.label || 'Preset',
    tempF: Math.round(preset.tempF),
  }));
}

function cleanEvents(value: ScheduleEvent[] | undefined): ScheduleEvent[] {
  if (!Array.isArray(value)) {
    return defaultEvents();
  }
  return value.filter((event) => event && typeof event.id === 'string' && Array.isArray(event.days));
}

function cleanHold(value: HoldState | undefined): HoldState {
  if (!value) {
    return null;
  }
  return {
    until: typeof value.until === 'string' ? value.until : null,
    label: value.label || '',
  };
}
