import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';

import { celsiusToFahrenheit } from '@/domain/temperature';
import { redactSecrets } from '@/devices/redact';

export const SWITCHBOT_BASE = 'https://api.switch-bot.com/v1.1';

export const PRESS_COMMAND = {
  commandType: 'command',
  command: 'press',
  parameter: 'default',
} as const;

export type Credentials = {
  token: string;
  secret: string;
  timestamp?: string;
  nonce?: string;
};

export type SwitchBotDevice = {
  deviceId: string;
  deviceName: string;
  deviceType: string;
  enableCloudService: boolean | null;
  hubDeviceId: string;
};

export type MeterReading = {
  temperatureC: number;
  temperatureF: number;
  humidity: number;
  co2Ppm: number;
  battery: number | null;
};

export class SwitchBotError extends Error {
  readonly statusCode: number | null;

  constructor(message: string, statusCode: number | null = null) {
    super(message);
    this.name = 'SwitchBotError';
    this.statusCode = statusCode;
  }
}

export class TransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransportError';
  }
}

export function signSwitchBot(input: {
  token: string;
  secret: string;
  timestamp: string;
  nonce: string;
}): string {
  const data = `${input.token}${input.timestamp}${input.nonce}`;
  const mac = hmac(sha256, utf8(input.secret), utf8(data));
  return bytesToBase64(mac);
}

export function createNonce(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `nonce-${Math.random().toString(16).slice(2)}`;
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }
  return btoa(binary);
}

function authHeaders(creds: Credentials): Record<string, string> {
  const timestamp = creds.timestamp ?? String(Date.now());
  const nonce = creds.nonce ?? createNonce();
  const sign = signSwitchBot({
    token: creds.token,
    secret: creds.secret,
    timestamp,
    nonce,
  });
  return {
    Authorization: creds.token,
    sign,
    nonce,
    t: timestamp,
    'Content-Type': 'application/json',
  };
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

async function switchbotRequest(
  creds: Credentials,
  path: string,
  init: { method: 'GET' | 'POST'; body?: unknown },
  fetchImpl: FetchLike,
): Promise<unknown> {
  const secrets = [creds.secret, creds.token];
  let response: Response;
  try {
    response = await fetchImpl(`${SWITCHBOT_BASE}${path}`, {
      method: init.method,
      headers: authHeaders(creds),
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch (error) {
    const raw = error instanceof Error ? error.message : 'Network request failed';
    throw new TransportError(redactSecrets(raw, secrets));
  }
  let text = '';
  try {
    text = await response.text();
  } catch (error) {
    const raw = error instanceof Error ? error.message : 'Could not read the SwitchBot response';
    throw new TransportError(redactSecrets(raw, secrets));
  }
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new SwitchBotError(redactSecrets('SwitchBot returned a response that was not JSON.', secrets));
  }
  if (!payload || typeof payload !== 'object') {
    throw new SwitchBotError('SwitchBot returned an empty response.');
  }
  const record = payload as { statusCode?: unknown; message?: unknown; body?: unknown };
  if (record.statusCode !== 100) {
    const code = typeof record.statusCode === 'number' ? record.statusCode : null;
    const message = typeof record.message === 'string' ? record.message : 'Request failed';
    const readable = redactSecrets(`SwitchBot error ${code ?? 'unknown'}: ${message}`, secrets);
    throw new SwitchBotError(readable, code);
  }
  return record.body;
}

export function parseDeviceList(body: unknown): SwitchBotDevice[] {
  if (!body || typeof body !== 'object') {
    return [];
  }
  const list = (body as { deviceList?: unknown }).deviceList;
  if (!Array.isArray(list)) {
    return [];
  }
  const devices: SwitchBotDevice[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const record = item as Record<string, unknown>;
    if (typeof record.deviceId !== 'string') {
      continue;
    }
    devices.push({
      deviceId: record.deviceId,
      deviceName: typeof record.deviceName === 'string' ? record.deviceName : 'Unnamed device',
      deviceType: typeof record.deviceType === 'string' ? record.deviceType : 'Unknown',
      enableCloudService:
        typeof record.enableCloudService === 'boolean' ? record.enableCloudService : null,
      hubDeviceId: typeof record.hubDeviceId === 'string' ? record.hubDeviceId : '',
    });
  }
  return devices;
}

export function parseMeterStatus(body: unknown): MeterReading {
  if (!body || typeof body !== 'object') {
    throw new SwitchBotError('Meter status was empty.');
  }
  const record = body as Record<string, unknown>;
  if (typeof record.temperature !== 'number') {
    throw new SwitchBotError('Meter status did not include a temperature.');
  }
  if (typeof record.humidity !== 'number') {
    throw new SwitchBotError('Meter status did not include humidity.');
  }
  if (typeof record.CO2 !== 'number') {
    throw new SwitchBotError('Meter status did not include CO2.');
  }
  return {
    temperatureC: record.temperature,
    temperatureF: celsiusToFahrenheit(record.temperature),
    humidity: record.humidity,
    co2Ppm: record.CO2,
    battery: typeof record.battery === 'number' ? record.battery : null,
  };
}

export function parseBotBattery(body: unknown): number | null {
  if (!body || typeof body !== 'object') {
    return null;
  }
  const battery = (body as { battery?: unknown }).battery;
  if (typeof battery !== 'number') {
    return null;
  }
  return battery;
}

export async function listDevices(creds: Credentials, fetchImpl: FetchLike = fetch): Promise<SwitchBotDevice[]> {
  const body = await switchbotRequest(creds, '/devices', { method: 'GET' }, fetchImpl);
  return parseDeviceList(body);
}

export async function pressBot(
  creds: Credentials,
  deviceId: string,
  fetchImpl: FetchLike = fetch,
): Promise<void> {
  await switchbotRequest(
    creds,
    `/devices/${encodeURIComponent(deviceId)}/commands`,
    { method: 'POST', body: PRESS_COMMAND },
    fetchImpl,
  );
}

export async function readMeter(
  creds: Credentials,
  deviceId: string,
  fetchImpl: FetchLike = fetch,
): Promise<MeterReading> {
  const body = await switchbotRequest(
    creds,
    `/devices/${encodeURIComponent(deviceId)}/status`,
    { method: 'GET' },
    fetchImpl,
  );
  return parseMeterStatus(body);
}

export async function readBotBattery(
  creds: Credentials,
  deviceId: string,
  fetchImpl: FetchLike = fetch,
): Promise<number | null> {
  const body = await switchbotRequest(
    creds,
    `/devices/${encodeURIComponent(deviceId)}/status`,
    { method: 'GET' },
    fetchImpl,
  );
  return parseBotBattery(body);
}

export function deviceNotes(device: {
  deviceName: string;
  enableCloudService: boolean | null;
  hubDeviceId: string;
}): string[] {
  const notes: string[] = [];
  if (device.enableCloudService === false) {
    notes.push(
      `${device.deviceName} has cloud service turned off. Turn it on in the SwitchBot app, or remote commands will not arrive.`,
    );
  }
  if (!device.hubDeviceId) {
    notes.push(
      `${device.deviceName} is not linked to a hub. Remote control needs a SwitchBot Hub near the device.`,
    );
  }
  return notes;
}
