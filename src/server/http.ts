import { listDevices, pressBot, readMeter } from '../devices/switchbot';
import { PressOutcomeError } from '../domain/pressSession';
import type { CommandSource } from '../domain/pressSession';
import { deviceIds, executeSharedPress, runSchedulerTick } from './engine';
import type { ServerEnv } from './env';
import { sameSecret } from './env';
import { handleMcp } from './mcp';
import type { SetpointDb } from './sqlDb';
import type { SharedSnapshot } from './types';

export type HandlerOptions = {
  db: SetpointDb;
  env: ServerEnv;
  now?: () => Date;
  pressDevice?: (deviceId: string, signal: AbortSignal) => Promise<void>;
  readMeterDevice?: (deviceId: string) => Promise<{ temperatureF: number; humidity: number; co2Ppm: number }>;
  listRemoteDevices?: () => Promise<{ deviceId: string; deviceName: string; deviceType: string; enableCloudService: boolean | null; hubDeviceId: string }[]>;
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-setpoint-cron-secret',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

function empty(): Response {
  return new Response(null, { status: 204, headers: CORS });
}

export function authorizeApp(request: Request, env: ServerEnv): boolean {
  if (!env.anonKey) {
    return false;
  }
  const apikey = request.headers.get('apikey') ?? '';
  const bearer = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  return sameSecret(apikey, env.anonKey) || sameSecret(bearer, env.anonKey);
}

export function authorizeCron(request: Request, env: ServerEnv): boolean {
  if (!env.cronSecret) {
    return false;
  }
  return sameSecret(request.headers.get('x-setpoint-cron-secret') ?? '', env.cronSecret);
}

export function authorizeMcp(request: Request, env: ServerEnv): boolean {
  if (!env.mcpKey) {
    return false;
  }
  const bearer = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  return sameSecret(bearer, env.mcpKey);
}

async function credentials(db: SetpointDb, env: ServerEnv): Promise<{ token: string; secret: string } | null> {
  const stored = await db.readCredentials();
  if (stored?.token && stored?.secret) {
    return stored;
  }
  if (env.switchbotToken && env.switchbotSecret) {
    return { token: env.switchbotToken, secret: env.switchbotSecret };
  }
  return null;
}

function cloudReason(state: SharedSnapshot): string | null {
  const up = state.deviceMap.up;
  const down = state.deviceMap.down;
  if (up?.enableCloudService === false) {
    return `${up.name} has cloud service turned off. Setpoint does not fall back to Bluetooth.`;
  }
  if (down?.enableCloudService === false) {
    return `${down.name} has cloud service turned off. Setpoint does not fall back to Bluetooth.`;
  }
  return null;
}

async function pressWith(options: HandlerOptions, state: SharedSnapshot) {
  const ids = deviceIds(state.deviceMap);
  return async (direction: 'up' | 'down', signal: AbortSignal) => {
    const id = direction === 'up' ? ids.upId : ids.downId;
    if (!id) {
      throw new PressOutcomeError('Map both bots before changing the temperature.', 'rejected');
    }
    if (options.pressDevice) {
      await options.pressDevice(id, signal);
      return;
    }
    const creds = await credentials(options.db, options.env);
    if (!creds) {
      throw new PressOutcomeError('SwitchBot credentials are not on the server.', 'rejected');
    }
    await pressBot(creds, id, fetch, signal);
  };
}

export async function handleState(request: Request, options: HandlerOptions): Promise<Response> {
  if (request.method === 'OPTIONS') {
    return empty();
  }
  if (!authorizeApp(request, options.env)) {
    return json({ error: 'Unauthorized.' }, 401);
  }
  if (request.method === 'GET') {
    return json(await options.db.readState());
  }
  if (request.method === 'PUT') {
    const body = (await request.json()) as Partial<SharedSnapshot> & { version?: number };
    const version = body.version && body.version > 0 ? body.version : null;
    const patch: Record<string, unknown> = {};
    const keys = [
      'virtualSetpoint',
      'catchupFrom',
      'mode',
      'hold',
      'settings',
      'deviceMap',
      'presets',
      'events',
      'records',
      'schedulePhase',
      'catchupNote',
      'roomLabel',
    ] as const;
    for (const key of keys) {
      if (key in body) {
        patch[key] = body[key];
      }
    }
    const lease = await options.db.readLease();
    const leaseRunning = lease.phase === 'running' && lease.leaseUntil !== null && Date.parse(lease.leaseUntil) > Date.now();
    if (leaseRunning) {
      delete patch.virtualSetpoint;
    }
    if (version === null && Object.prototype.hasOwnProperty.call(patch, 'virtualSetpoint')) {
      const current = await options.db.readState();
      if (current.virtualSetpoint !== null && current.virtualSetpoint !== patch.virtualSetpoint) {
        delete patch.virtualSetpoint;
      }
    }
    const saved = await options.db.patchState(version, patch);
    if (!saved) {
      return json({ error: 'Shared state changed. Pull and retry.' }, 409);
    }
    return json(saved);
  }
  return json({ error: 'Method not allowed.' }, 405);
}

export async function handlePress(request: Request, options: HandlerOptions): Promise<Response> {
  if (request.method === 'OPTIONS') {
    return empty();
  }
  if (!authorizeApp(request, options.env)) {
    return json({ error: 'Unauthorized.' }, 401);
  }
  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed.' }, 405);
  }
  const body = (await request.json()) as { target?: number; source?: CommandSource };
  if (typeof body.target !== 'number' || !body.source) {
    return json({ error: 'Say which temperature to reach.' }, 400);
  }
  const state = await options.db.readState();
  const blocked = cloudReason(state);
  if (blocked) {
    return json({
      status: 'refused',
      stoppedAt: state.virtualSetpoint ?? body.target,
      wanted: body.target,
      reason: blocked,
      notifyCheck: false,
    });
  }
  const result = await executeSharedPress(options.db, {
    target: body.target,
    source: body.source,
    owner: 'app',
    now: options.now,
    armMs: 400,
    press: await pressWith(options, state),
  });
  return json(result);
}

export async function handleSession(request: Request, options: HandlerOptions): Promise<Response> {
  if (request.method === 'OPTIONS') {
    return empty();
  }
  if (!authorizeApp(request, options.env)) {
    return json({ error: 'Unauthorized.' }, 401);
  }
  if (request.method === 'POST') {
    await options.db.requestCancel();
    return json({ ok: true });
  }
  const lease = await options.db.readLease();
  return json({ progress: lease.phase === 'running' ? lease.progress : null });
}

export async function handleTick(request: Request, options: HandlerOptions): Promise<Response> {
  if (request.method === 'OPTIONS') {
    return empty();
  }
  if (!authorizeCron(request, options.env)) {
    return json({ error: 'Unauthorized.' }, 401);
  }
  const state = await options.db.readState();
  const result = await runSchedulerTick(options.db, {
    now: options.now,
    press: await pressWith(options, state),
  });
  return json(result);
}

export async function handleMeter(request: Request, options: HandlerOptions): Promise<Response> {
  if (request.method === 'OPTIONS') {
    return empty();
  }
  if (!authorizeCron(request, options.env) && !authorizeApp(request, options.env)) {
    return json({ error: 'Unauthorized.' }, 401);
  }
  const state = await options.db.readState();
  const meter = state.deviceMap.meter;
  if (state.mode !== 'live' || !meter) {
    return json({ sample: null });
  }
  if (meter.enableCloudService === false) {
    return json({ error: 'The meter has cloud service turned off.' }, 409);
  }
  const now = options.now ?? (() => new Date());
  let reading: { temperatureF: number; humidity: number; co2Ppm: number };
  if (options.readMeterDevice) {
    reading = await options.readMeterDevice(meter.id);
  } else {
    const creds = await credentials(options.db, options.env);
    if (!creds) {
      return json({ error: 'SwitchBot credentials are not on the server.' }, 409);
    }
    const live = await readMeter(creds, meter.id);
    reading = { temperatureF: live.temperatureF, humidity: live.humidity, co2Ppm: live.co2Ppm };
  }
  const sample = { at: now().toISOString(), ...reading };
  await options.db.insertRead(sample);
  return json({ sample });
}

export async function handleHistory(request: Request, options: HandlerOptions): Promise<Response> {
  if (request.method === 'OPTIONS') {
    return empty();
  }
  if (!authorizeApp(request, options.env)) {
    return json({ error: 'Unauthorized.' }, 401);
  }
  const url = new URL(request.url);
  const span = url.searchParams.get('span') === 'week' ? 7 : 1;
  const now = options.now ?? (() => new Date());
  const since = new Date(now().getTime() - span * 24 * 60 * 60 * 1000).toISOString();
  const samples = await options.db.listReads(since);
  const changes = await options.db.listChanges(since);
  return json({ samples, changes });
}

export async function handleCredentials(request: Request, options: HandlerOptions): Promise<Response> {
  if (request.method === 'OPTIONS') {
    return empty();
  }
  if (!authorizeApp(request, options.env)) {
    return json({ error: 'Unauthorized.' }, 401);
  }
  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed.' }, 405);
  }
  const body = (await request.json()) as { token?: string; secret?: string };
  const token = body.token?.trim() ?? '';
  const secret = body.secret?.trim() ?? '';
  if (!token || !secret) {
    return json({ error: 'Enter both the token and the secret.' }, 400);
  }
  await options.db.saveCredentials(token, secret);
  return json({ ok: true });
}

export async function handleDevices(request: Request, options: HandlerOptions): Promise<Response> {
  if (request.method === 'OPTIONS') {
    return empty();
  }
  if (!authorizeApp(request, options.env)) {
    return json({ error: 'Unauthorized.' }, 401);
  }
  if (options.listRemoteDevices) {
    const devices = await options.listRemoteDevices();
    return json({ devices });
  }
  const creds = await credentials(options.db, options.env);
  if (!creds) {
    return json({ error: 'SwitchBot credentials are not on the server.' }, 409);
  }
  const devices = await listDevices(creds);
  return json({ devices });
}

export async function handlePrune(request: Request, options: HandlerOptions): Promise<Response> {
  if (request.method === 'OPTIONS') {
    return empty();
  }
  if (!authorizeCron(request, options.env)) {
    return json({ error: 'Unauthorized.' }, 401);
  }
  return json(await options.db.pruneReads());
}

export async function handleMcpRequest(request: Request, options: HandlerOptions): Promise<Response> {
  if (request.method === 'OPTIONS') {
    return empty();
  }
  if (!authorizeMcp(request, options.env)) {
    return json({ error: 'Unauthorized.' }, 401);
  }
  const body = request.method === 'POST' ? await request.json() : { method: 'ping', id: null };
  const state = await options.db.readState();
  const result = await handleMcp(options.db, body, {
    now: options.now,
    press: await pressWith(options, state),
    readMeter: options.readMeterDevice
      ? async () => {
          const meter = (await options.db.readState()).deviceMap.meter;
          if (!meter) {
            throw new Error('No meter is mapped.');
          }
          return options.readMeterDevice!(meter.id);
        }
      : undefined,
  });
  return json(result);
}
