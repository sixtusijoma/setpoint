import type { CommandSource } from '@/domain/pressSession';
import type { HoldState, RunRecord, ScheduleEvent } from '@/domain/schedule';
import type { SchedulePhase } from '@/domain/scheduleRunner';
import type { SwitchBotDevice } from '@/devices/switchbot';
import { readChangePage, type ChangePage, type HistorySpan } from '@/domain/history';
import type { HistorySample, SetpointChange } from '@/domain/history';
import { chunkMeterCsv, combineSummaries, emptySummary, type MeterImportSummary } from '@/domain/meterCsv';
import type { DeviceMap, Preset, Settings } from '@/state/model';

export type ServerConfig = {
  url: string;
  publishableKey: string;
};

export type SharedSnapshot = {
  version: number;
  virtualSetpoint: number | null;
  catchupFrom: string | null;
  mode: 'demo' | 'live';
  hold: HoldState;
  settings: Settings;
  deviceMap: DeviceMap;
  presets: Preset[];
  events: ScheduleEvent[];
  records: RunRecord[];
  schedulePhase: SchedulePhase;
  catchupNote: string | null;
  roomLabel: string;
};

export type RemoteProgress = {
  index: number;
  total: number;
  target: number;
  label: 'press' | 'finishing';
};

export type RemoteCommandResult = {
  status: 'done' | 'already' | 'cancelled' | 'failed' | 'refused' | 'busy' | 'ambiguous';
  stoppedAt: number;
  wanted: number;
  reason?: string;
  notifyCheck?: boolean;
};

export class ServerAuthError extends Error {
  constructor() {
    super('The app key was rejected.');
    this.name = 'ServerAuthError';
  }
}

const APP_KEY_HEADER = 'x-setpoint-app-key';

export function readServerConfig(): ServerConfig | null {
  const url = process.env.EXPO_PUBLIC_SUPABASE_URL?.trim();
  const publishableKey = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();
  if (!url || !publishableKey) {
    return null;
  }
  return { url: url.replace(/\/$/, ''), publishableKey };
}

function safeMessage(message: string, appKey: string): string {
  if (appKey && message.includes(appKey)) {
    return 'Server request failed.';
  }
  return message;
}

async function call<T>(config: ServerConfig, appKey: string, path: string, init?: RequestInit): Promise<T> {
  if (!appKey) {
    throw new ServerAuthError();
  }
  const headers = new Headers(init?.headers);
  headers.set('Content-Type', 'application/json');
  headers.set('apikey', config.publishableKey);
  headers.set('Authorization', `Bearer ${config.publishableKey}`);
  headers.set(APP_KEY_HEADER, appKey);
  const response = await fetch(`${config.url}/functions/v1/${path}`, {
    ...init,
    headers,
  });
  const text = await response.text();
  if (response.status === 401) {
    throw new ServerAuthError();
  }
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { error: text };
    }
  }
  if (!response.ok) {
    const message =
      payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string'
        ? payload.error
        : `Server request failed (${response.status}).`;
    throw new Error(safeMessage(message, appKey));
  }
  return payload as T;
}

export function fetchState(config: ServerConfig, appKey: string): Promise<SharedSnapshot> {
  return call(config, appKey, 'state');
}

export function saveState(
  config: ServerConfig,
  appKey: string,
  patch: Partial<SharedSnapshot> & { version?: number },
): Promise<SharedSnapshot> {
  return call(config, appKey, 'state', { method: 'PUT', body: JSON.stringify(patch) });
}

export function recalibrateRemote(
  config: ServerConfig,
  appKey: string,
  temperatureF: number,
): Promise<{ previous: number | null; setpoint: number; version: number }> {
  return call(config, appKey, 'recalibrate', { method: 'POST', body: JSON.stringify({ temperatureF }) });
}

export function runRemotePress(
  config: ServerConfig,
  appKey: string,
  body: { target: number; source: CommandSource },
): Promise<RemoteCommandResult> {
  return call(config, appKey, 'press', { method: 'POST', body: JSON.stringify(body) });
}

export function cancelRemotePress(config: ServerConfig, appKey: string): Promise<{ ok: true }> {
  return call(config, appKey, 'session', { method: 'POST', body: JSON.stringify({ cancel: true }) });
}

export function fetchRemoteSession(config: ServerConfig, appKey: string): Promise<{ progress: RemoteProgress | null }> {
  return call(config, appKey, 'session');
}

export function fetchHistory(
  config: ServerConfig,
  appKey: string,
  span: HistorySpan,
): Promise<{ samples: HistorySample[]; changes: SetpointChange[] }> {
  return call(config, appKey, `history?span=${span}`);
}

export async function fetchChangePage(
  config: ServerConfig,
  appKey: string,
  cursor: string | null,
  limit: number,
): Promise<ChangePage> {
  const params = new URLSearchParams({ view: 'changes', limit: String(limit) });
  if (cursor) {
    params.set('cursor', cursor);
  }
  const payload = await call<{ changes?: unknown; nextCursor?: unknown }>(config, appKey, `history?${params.toString()}`);
  return readChangePage(payload ?? {});
}

export async function importMeterCsvRemote(
  config: ServerConfig,
  appKey: string,
  csv: string,
): Promise<MeterImportSummary> {
  const chunks = chunkMeterCsv(csv, 2000);
  let summary = emptySummary();
  for (const chunk of chunks) {
    const part = await call<MeterImportSummary>(config, appKey, 'import-meter', {
      method: 'POST',
      body: JSON.stringify({ csv: chunk }),
    });
    summary = combineSummaries(summary, part);
  }
  return summary;
}

export function saveRemoteCredentials(
  config: ServerConfig,
  appKey: string,
  token: string,
  secret: string,
): Promise<{ ok: true }> {
  return call(config, appKey, 'credentials', { method: 'POST', body: JSON.stringify({ token, secret }) });
}

export function fetchRemoteDevices(config: ServerConfig, appKey: string): Promise<{ devices: SwitchBotDevice[] }> {
  return call(config, appKey, 'devices', { method: 'POST', body: '{}' });
}

export function requestRemoteMeter(config: ServerConfig, appKey: string): Promise<{ sample: HistorySample | null }> {
  return call(config, appKey, 'meter', { method: 'POST', body: '{}' });
}
