import AsyncStorage from '@react-native-async-storage/async-storage';

import { LOCAL_HISTORY_CAP, type HistorySample, type SetpointChange } from '@/domain/history';
import { defaultEvents, normalizeStatus, type HoldState, type RunRecord, type ScheduleEvent } from '@/domain/schedule';
import { initialClimate } from '@/devices/simulator';
import { isSystemMode, modeStepOf } from '@/domain/systemMode';
import { activeDegrees } from '@/domain/modeSetpoint';
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
    ...cleanClimate(record),
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
      modeStep: modeStepOf(settings.modeStep),
    },
    deviceMap: {
      up: cleanDevice(record.deviceMap?.up),
      down: cleanDevice(record.deviceMap?.down),
      mode: cleanDevice(record.deviceMap?.mode),
      meter: cleanDevice(record.deviceMap?.meter),
    },
    presets: cleanPresets(record.presets, defaultPresets()),
    events: cleanEvents(record.events),
    records: cleanRecords(record.records),
    hold: cleanHold(record.hold, cleanEvents(record.events)),
    log: Array.isArray(record.log) ? record.log.slice(0, 200) : [],
    demoClimate: {
      ...initialClimate(nowIso),
      ...(record.demoClimate ?? {}),
      batteryMode:
        typeof record.demoClimate?.batteryMode === 'number' ? record.demoClimate.batteryMode : initialClimate(nowIso).batteryMode,
      loseNextResponse: Boolean(record.demoClimate?.loseNextResponse),
      failNextPress: Boolean(record.demoClimate?.failNextPress),
    },
    lastLive:
      record.lastLive && typeof record.lastLive.temperatureF === 'number'
        ? {
            ...record.lastLive,
            batteryMode: typeof record.lastLive.batteryMode === 'number' ? record.lastLive.batteryMode : null,
          }
        : null,
    catchupNote: typeof record.catchupNote === 'string' ? record.catchupNote : null,
    schedulePhase: record.schedulePhase === 'paused-after-failure' ? 'paused-after-failure' : 'armed',
    history: cleanHistory(record.history),
    changes: cleanChanges(record.changes),
  };
}

function cleanClimate(record: Partial<Persisted>): Pick<
  Persisted,
  'systemMode' | 'heatSetpoint' | 'coolSetpoint' | 'virtualSetpoint' | 'batteryCache'
> {
  const legacy = typeof record.virtualSetpoint === 'number' ? Math.round(record.virtualSetpoint) : null;
  const heat = 'heatSetpoint' in record ? whole(record.heatSetpoint) : legacy;
  const cool = 'coolSetpoint' in record ? whole(record.coolSetpoint) : legacy;
  const systemMode = isSystemMode(record.systemMode) ? record.systemMode : 'unknown';
  return {
    systemMode,
    heatSetpoint: heat,
    coolSetpoint: cool,
    virtualSetpoint: activeDegrees(systemMode, { heat, cool }),
    batteryCache: cleanCache(record.batteryCache),
  };
}

function whole(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : null;
}

function cleanCache(value: Persisted['batteryCache'] | undefined): Persisted['batteryCache'] {
  if (!value || typeof value.fetchedAt !== 'string') {
    return null;
  }
  return {
    up: whole(value.up),
    down: whole(value.down),
    mode: whole(value.mode),
    fetchedAt: value.fetchedAt,
    ...(typeof value.failedAt === 'string' ? { failedAt: value.failedAt } : {}),
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

function cleanHold(value: unknown, events: ScheduleEvent[]): HoldState {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const record = value as {
    kind?: unknown;
    eventId?: unknown;
    label?: unknown;
    occurrenceAt?: unknown;
    until?: unknown;
  };
  if (record.kind === 'until-resume') {
    return { kind: 'until-resume' };
  }
  if (record.kind === 'until-event' && typeof record.eventId === 'string' && typeof record.occurrenceAt === 'string') {
    return {
      kind: 'until-event',
      eventId: record.eventId,
      label: typeof record.label === 'string' ? record.label : '',
      occurrenceAt: record.occurrenceAt,
    };
  }
  const label = typeof record.label === 'string' ? record.label : '';
  const until = typeof record.until === 'string' ? record.until : '';
  if (!until) {
    return label ? { kind: 'until-resume' } : null;
  }
  const match = events.find((event) => event.label === label);
  if (!match) {
    return { kind: 'until-resume' };
  }
  return { kind: 'until-event', eventId: match.id, label: match.label, occurrenceAt: until };
}

function cleanRecords(value: unknown): RunRecord[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const records: RunRecord[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const record = item as RunRecord;
    const status = typeof record.status === 'string' ? normalizeStatus(record.status) : null;
    if (!status || typeof record.key !== 'string') {
      continue;
    }
    records.push({ ...record, status });
  }
  return records.slice(-400);
}

function cleanHistory(value: unknown): HistorySample[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item) => item && typeof item.at === 'string' && typeof item.temperatureF === 'number')
    .slice(-LOCAL_HISTORY_CAP) as HistorySample[];
}

function cleanChanges(value: unknown): SetpointChange[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item) => item && typeof item.at === 'string' && typeof item.setpoint === 'number')
    .slice(-400) as SetpointChange[];
}
