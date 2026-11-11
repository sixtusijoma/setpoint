import type { CommandSource } from '@/domain/pressSession';
import type { HoldState, RunRecord, ScheduleEvent } from '@/domain/schedule';
import type { SchedulePhase } from '@/domain/scheduleRunner';
import type { SwitchBotDevice } from '@/devices/switchbot';
import type { HistorySample, SetpointChange } from '@/domain/history';
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

export function readServerConfig(): ServerConfig | null {
  const url = process.env.EXPO_PUBLIC_SUPABASE_URL?.trim();
  const publishableKey = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();
  if (!url || !publishableKey) {
    return null;
  }
  return { url: url.replace(/\/$/, ''), publishableKey };
}

async function call<T>(config: ServerConfig, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${config.url}/functions/v1/${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      apikey: config.publishableKey,
      Authorization: `Bearer ${config.publishableKey}`,
      ...(init?.headers ?? {}),
    },
  });
  const text = await response.text();
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
    throw new Error(message);
  }
  return payload as T;
}

export function fetchState(config: ServerConfig): Promise<SharedSnapshot> {
  return call(config, 'state');
}

export function saveState(config: ServerConfig, patch: Partial<SharedSnapshot> & { version?: number }): Promise<SharedSnapshot> {
  return call(config, 'state', { method: 'PUT', body: JSON.stringify(patch) });
}

export function runRemotePress(
  config: ServerConfig,
  body: { target: number; source: CommandSource },
): Promise<RemoteCommandResult> {
  return call(config, 'press', { method: 'POST', body: JSON.stringify(body) });
}

export function cancelRemotePress(config: ServerConfig): Promise<{ ok: true }> {
  return call(config, 'session', { method: 'POST', body: JSON.stringify({ cancel: true }) });
}

export function fetchRemoteSession(config: ServerConfig): Promise<{ progress: RemoteProgress | null }> {
  return call(config, 'session');
}

export function fetchHistory(
  config: ServerConfig,
  span: 'day' | 'week',
): Promise<{ samples: HistorySample[]; changes: SetpointChange[] }> {
  return call(config, `history?span=${span}`);
}

export function saveRemoteCredentials(
  config: ServerConfig,
  token: string,
  secret: string,
): Promise<{ ok: true }> {
  return call(config, 'credentials', { method: 'POST', body: JSON.stringify({ token, secret }) });
}

export function fetchRemoteDevices(config: ServerConfig): Promise<{ devices: SwitchBotDevice[] }> {
  return call(config, 'devices', { method: 'POST', body: '{}' });
}

export function requestRemoteMeter(config: ServerConfig): Promise<{ sample: HistorySample | null }> {
  return call(config, 'meter', { method: 'POST', body: '{}' });
}
