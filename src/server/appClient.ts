import type { CommandSource } from '@/domain/pressSession';
import type { HoldState, RunRecord, ScheduleEvent } from '@/domain/schedule';
import type { SchedulePhase } from '@/domain/scheduleRunner';
import type { SwitchBotDevice } from '@/devices/switchbot';
import { readChangePage, withinRange, type ChangePage, type HistorySample, type SetpointChange } from '@/domain/history';
import type { HistoryWindow, HistoryWindowData } from '@/domain/historyWindow';
import { chunkMeterCsv, combineSummaries, emptySummary, type MeterImportSummary } from '@/domain/meterCsv';
import type { BatteryReading } from '@/domain/batteryFetch';
import type { SystemMode } from '@/domain/systemMode';
import type { DeviceMap, Preset, Settings } from '@/state/model';

export type ServerConfig = {
  url: string;
  publishableKey: string;
};

export type SharedSnapshot = {
  version: number;
  virtualSetpoint: number | null;
  systemMode: SystemMode;
  heatSetpoint: number | null;
  coolSetpoint: number | null;
  batteryCache: BatteryReading | null;
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
  kind?: 'setpoint' | 'mode';
  systemMode?: SystemMode;
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
export const NETWORK_RETRY_DELAY_MS = 300;

const TRANSIENT_NETWORK =
  /network connection was lost|fetch failed|network request failed|failed to fetch|load failed|timed out|\btimeout\b/i;

export function isTransientNetworkError(error: unknown): boolean {
  if (error instanceof ServerAuthError || !error || typeof error !== 'object') {
    return false;
  }
  const name = 'name' in error && typeof error.name === 'string' ? error.name : '';
  const message = 'message' in error && typeof error.message === 'string' ? error.message : '';
  if (name === 'TypeError' || name === 'FetchError' || name === 'AbortError' || name === 'TimeoutError') {
    return true;
  }
  return TRANSIENT_NETWORK.test(message);
}

function transportFailure(error: unknown): Error {
  if (error instanceof Error && isTransientNetworkError(error)) {
    return error;
  }
  const message = error instanceof Error && error.message ? error.message : 'Network request failed';
  return new TypeError(message);
}

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

async function call<T>(
  config: ServerConfig,
  appKey: string,
  path: string,
  init?: RequestInit,
  idempotent = false,
): Promise<T> {
  if (!idempotent) {
    return attempt(config, appKey, path, init);
  }
  try {
    return await attempt(config, appKey, path, init);
  } catch (error) {
    if (!isTransientNetworkError(error)) {
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, NETWORK_RETRY_DELAY_MS));
    return attempt(config, appKey, path, init);
  }
}

async function attempt<T>(config: ServerConfig, appKey: string, path: string, init?: RequestInit): Promise<T> {
  if (!appKey) {
    throw new ServerAuthError();
  }
  const headers = new Headers(init?.headers);
  headers.set('Content-Type', 'application/json');
  headers.set('apikey', config.publishableKey);
  headers.set('Authorization', `Bearer ${config.publishableKey}`);
  headers.set(APP_KEY_HEADER, appKey);
  let response: Response;
  try {
    response = await fetch(`${config.url}/functions/v1/${path}`, {
      ...init,
      headers,
    });
  } catch (error) {
    throw transportFailure(error);
  }
  let text = '';
  try {
    text = await response.text();
  } catch (error) {
    throw transportFailure(error);
  }
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
  return call(config, appKey, 'state', undefined, true);
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
  return call(config, appKey, 'session', undefined, true);
}

export const OLD_HISTORY_FUNCTION =
  'The history function on the server is out of date, so only the current day, week, or month can be shown. Redeploy it to browse older readings.';

export async function fetchHistoryWindow(
  config: ServerConfig,
  appKey: string,
  window: HistoryWindow,
  current: boolean,
): Promise<HistoryWindowData> {
  const params = new URLSearchParams({ since: window.since, until: window.until });
  if (window.span !== 'year') {
    params.set('span', window.span);
  }
  const payload = await call<{
    samples?: HistorySample[];
    changes?: SetpointChange[];
    bucketSeconds?: number;
    firstAt?: string | null;
  }>(config, appKey, `history?${params.toString()}`, undefined, true);
  const samples = Array.isArray(payload?.samples) ? payload.samples : [];
  const changes = Array.isArray(payload?.changes) ? payload.changes : [];
  if (typeof payload?.bucketSeconds === 'number') {
    return { samples, changes, bucketSeconds: payload.bucketSeconds, firstAt: payload.firstAt ?? null };
  }
  if (!current || window.span === 'year') {
    throw new Error(OLD_HISTORY_FUNCTION);
  }
  return {
    samples: withinRange(samples, window.since, window.until),
    changes: withinRange(changes, window.since, window.until),
    bucketSeconds: window.bucketSeconds,
  };
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
  const payload = await call<{ changes?: unknown; nextCursor?: unknown }>(
    config,
    appKey,
    `history?${params.toString()}`,
    undefined,
    true,
  );
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

export function requestRemoteMeter(
  config: ServerConfig,
  appKey: string,
): Promise<{ sample: HistorySample | null; batteries?: BatteryReading | null }> {
  return call(config, appKey, 'meter', { method: 'POST', body: '{}' }, true);
}

export function runRemoteMode(
  config: ServerConfig,
  appKey: string,
  mode: 'heat' | 'off' | 'cool',
): Promise<{ status: string; systemMode: SystemMode; wanted: string; reason?: string; notifyCheck?: boolean }> {
  return call(config, appKey, 'set-mode', { method: 'POST', body: JSON.stringify({ mode }) });
}

export function recalibrateModeRemote(
  config: ServerConfig,
  appKey: string,
  mode: 'heat' | 'off' | 'cool',
): Promise<{ previous: SystemMode; systemMode: SystemMode; setpoint: number | null; version: number }> {
  return call(config, appKey, 'recalibrate-mode', { method: 'POST', body: JSON.stringify({ mode }) });
}
