import { listDevices, pressBot, readMeter } from '../devices/switchbot';
import { PressOutcomeError } from '../domain/pressSession';
import type { CommandSource } from '../domain/pressSession';
import { deviceIds, executeSharedPress, RecalibrateError, recalibrateShared, runSchedulerTick, type PressTiming } from './engine';
import { appKeyMatches, sameSecret, type ServerEnv } from './env';
import { handleMcp } from './mcp';
import type { SetpointDb } from './sqlDb';
import type { SharedSnapshot } from './types';

export type HandlerOptions = {
  db: SetpointDb;
  env: ServerEnv;
  now?: () => Date;
  timing?: PressTiming;
  pressDevice?: (deviceId: string, signal: AbortSignal) => Promise<void>;
  readMeterDevice?: (deviceId: string) => Promise<{ temperatureF: number; humidity: number; co2Ppm: number }>;
  listRemoteDevices?: () => Promise<{ deviceId: string; deviceName: string; deviceType: string; enableCloudService: boolean | null; hubDeviceId: string }[]>;
};

export const APP_KEY_HEADER = 'x-setpoint-app-key';

function corsHeaders(request: Request, env: ServerEnv): Record<string, string> {
  const allowed = env.webOrigin?.trim() ?? '';
  const origin = request.headers.get('origin') ?? '';
  if (!allowed || origin !== allowed) {
    return {};
  }
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-setpoint-app-key, x-setpoint-cron-secret',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
    Vary: 'Origin',
  };
}

function json(request: Request, env: ServerEnv, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(request, env) },
  });
}

function empty(request: Request, env: ServerEnv): Response {
  return new Response(null, { status: 204, headers: corsHeaders(request, env) });
}

export async function authorizeApp(request: Request, env: ServerEnv): Promise<boolean> {
  const provided = request.headers.get(APP_KEY_HEADER) ?? '';
  return appKeyMatches(provided, env.appKeyHash);
}

export async function requireApp(request: Request, env: ServerEnv): Promise<Response | null> {
  if (request.method === 'OPTIONS') {
    return empty(request, env);
  }
  if (!(await authorizeApp(request, env))) {
    return json(request, env, { error: 'Unauthorized.' }, 401);
  }
  return null;
}

async function requireAppOrCron(request: Request, env: ServerEnv): Promise<Response | null> {
  if (request.method === 'OPTIONS') {
    return empty(request, env);
  }
  if ((await authorizeApp(request, env)) || authorizeCron(request, env)) {
    return null;
  }
  return json(request, env, { error: 'Unauthorized.' }, 401);
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
  const denied = await requireApp(request, options.env);
  if (denied) {
    return denied;
  }
  if (request.method === 'GET') {
    return json(request, options.env, await options.db.readState());
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
      return json(request, options.env, { error: 'Shared state changed. Pull and retry.' }, 409);
    }
    return json(request, options.env, saved);
  }
  return json(request, options.env, { error: 'Method not allowed.' }, 405);
}

export async function handleRecalibrate(request: Request, options: HandlerOptions): Promise<Response> {
  const denied = await requireApp(request, options.env);
  if (denied) {
    return denied;
  }
  if (request.method !== 'POST') {
    return json(request, options.env, { error: 'Method not allowed.' }, 405);
  }
  const body = (await request.json()) as { temperatureF?: unknown };
  try {
    const result = await recalibrateShared(options.db, { temperatureF: body.temperatureF, now: options.now });
    return json(request, options.env, result);
  } catch (error) {
    if (error instanceof RecalibrateError) {
      return json(request, options.env, { error: error.message }, error.kind === 'busy' ? 409 : 400);
    }
    throw error;
  }
}

export async function handlePress(request: Request, options: HandlerOptions): Promise<Response> {
  const denied = await requireApp(request, options.env);
  if (denied) {
    return denied;
  }
  if (request.method !== 'POST') {
    return json(request, options.env, { error: 'Method not allowed.' }, 405);
  }
  const body = (await request.json()) as { target?: number; source?: CommandSource };
  if (typeof body.target !== 'number' || !body.source) {
    return json(request, options.env, { error: 'Say which temperature to reach.' }, 400);
  }
  const state = await options.db.readState();
  const blocked = cloudReason(state);
  if (blocked) {
    return json(request, options.env, {
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
    timing: options.timing,
    press: await pressWith(options, state),
  });
  return json(request, options.env, result);
}

export async function handleSession(request: Request, options: HandlerOptions): Promise<Response> {
  const denied = await requireApp(request, options.env);
  if (denied) {
    return denied;
  }
  if (request.method === 'POST') {
    await options.db.requestCancel();
    return json(request, options.env, { ok: true });
  }
  const lease = await options.db.readLease();
  return json(request, options.env, { progress: lease.phase === 'running' ? lease.progress : null });
}

export async function handleTick(request: Request, options: HandlerOptions): Promise<Response> {
  if (request.method === 'OPTIONS') {
    return empty(request, options.env);
  }
  if (!authorizeCron(request, options.env)) {
    return json(request, options.env, { error: 'Unauthorized.' }, 401);
  }
  const state = await options.db.readState();
  const result = await runSchedulerTick(options.db, {
    now: options.now,
    timing: options.timing,
    press: await pressWith(options, state),
  });
  return json(request, options.env, result);
}

export async function handleMeter(request: Request, options: HandlerOptions): Promise<Response> {
  const denied = await requireAppOrCron(request, options.env);
  if (denied) {
    return denied;
  }
  const state = await options.db.readState();
  const meter = state.deviceMap.meter;
  if (state.mode !== 'live' || !meter) {
    return json(request, options.env, { sample: null });
  }
  if (meter.enableCloudService === false) {
    return json(request, options.env, { error: 'The meter has cloud service turned off.' }, 409);
  }
  const now = options.now ?? (() => new Date());
  let reading: { temperatureF: number; humidity: number; co2Ppm: number };
  if (options.readMeterDevice) {
    reading = await options.readMeterDevice(meter.id);
  } else {
    const creds = await credentials(options.db, options.env);
    if (!creds) {
      return json(request, options.env, { error: 'SwitchBot credentials are not on the server.' }, 409);
    }
    const live = await readMeter(creds, meter.id);
    reading = { temperatureF: live.temperatureF, humidity: live.humidity, co2Ppm: live.co2Ppm };
  }
  const sample = { at: now().toISOString(), ...reading };
  await options.db.insertRead(sample);
  return json(request, options.env, { sample });
}

export async function handleHistory(request: Request, options: HandlerOptions): Promise<Response> {
  const denied = await requireApp(request, options.env);
  if (denied) {
    return denied;
  }
  const url = new URL(request.url);
  const span = url.searchParams.get('span') === 'week' ? 7 : 1;
  const now = options.now ?? (() => new Date());
  const since = new Date(now().getTime() - span * 24 * 60 * 60 * 1000).toISOString();
  const samples = await options.db.listReads(since);
  const changes = await options.db.listChanges(since);
  return json(request, options.env, { samples, changes });
}

export async function handleCredentials(request: Request, options: HandlerOptions): Promise<Response> {
  const denied = await requireApp(request, options.env);
  if (denied) {
    return denied;
  }
  if (request.method !== 'POST') {
    return json(request, options.env, { error: 'Method not allowed.' }, 405);
  }
  const body = (await request.json()) as { token?: string; secret?: string };
  const token = body.token?.trim() ?? '';
  const secret = body.secret?.trim() ?? '';
  if (!token || !secret) {
    return json(request, options.env, { error: 'Enter both the token and the secret.' }, 400);
  }
  await options.db.saveCredentials(token, secret);
  return json(request, options.env, { ok: true });
}

export async function handleDevices(request: Request, options: HandlerOptions): Promise<Response> {
  const denied = await requireApp(request, options.env);
  if (denied) {
    return denied;
  }
  if (options.listRemoteDevices) {
    const devices = await options.listRemoteDevices();
    return json(request, options.env, { devices });
  }
  const creds = await credentials(options.db, options.env);
  if (!creds) {
    return json(request, options.env, { error: 'SwitchBot credentials are not on the server.' }, 409);
  }
  const devices = await listDevices(creds);
  return json(request, options.env, { devices });
}

export async function handlePrune(request: Request, options: HandlerOptions): Promise<Response> {
  if (request.method === 'OPTIONS') {
    return empty(request, options.env);
  }
  if (!authorizeCron(request, options.env)) {
    return json(request, options.env, { error: 'Unauthorized.' }, 401);
  }
  return json(request, options.env, await options.db.pruneReads());
}

function meterReader(options: HandlerOptions) {
  return async (): Promise<{ temperatureF: number; humidity: number; co2Ppm: number }> => {
    const meter = (await options.db.readState()).deviceMap.meter;
    if (!meter) {
      throw new Error('No meter is mapped. Pick the meter in Settings.');
    }
    if (meter.enableCloudService === false) {
      throw new Error('The meter has cloud service turned off.');
    }
    if (options.readMeterDevice) {
      return options.readMeterDevice(meter.id);
    }
    const creds = await credentials(options.db, options.env);
    if (!creds) {
      throw new Error('SwitchBot credentials are not on the server.');
    }
    const live = await readMeter(creds, meter.id);
    return { temperatureF: live.temperatureF, humidity: live.humidity, co2Ppm: live.co2Ppm };
  };
}

export async function handleMcpRequest(request: Request, options: HandlerOptions): Promise<Response> {
  if (request.method === 'OPTIONS') {
    return empty(request, options.env);
  }
  if (!authorizeMcp(request, options.env)) {
    return json(request, options.env, { error: 'Unauthorized.' }, 401);
  }
  const body = request.method === 'POST' ? await request.json() : { method: 'ping', id: null };
  const state = await options.db.readState();
  const result = await handleMcp(options.db, body, {
    now: options.now,
    timing: options.timing,
    press: await pressWith(options, state),
    readMeter: meterReader(options),
  });
  return json(request, options.env, result);
}
