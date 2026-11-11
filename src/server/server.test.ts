import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { PressOutcomeError } from '../domain/pressSession';
import { editScheduleEvent, executeSharedPress, runSchedulerTick } from './engine';
import { handleCredentials, handleMcpRequest, handleMeter, handleState, handleTick } from './http';
import { handleMcp } from './mcp';
import { createRestDb } from './restDb';
import { createSqlDb, type SetpointDb } from './sqlDb';

const migration = readFileSync(
  path.join(process.cwd(), 'supabase/migrations/20261111120000_setpoint.sql'),
  'utf8',
);

const bot = (id: string) => ({
  id,
  name: id,
  deviceType: 'Bot',
  enableCloudService: true,
  hubDeviceId: 'hub',
});

const settings = { step: 1, delayMs: 0, minF: 50, maxF: 85, pressCap: 15, wakeFirst: false };
const wednesdayMorning = new Date('2026-11-11T15:00:00.000Z');

describe('shared server', () => {
  const pg = new PGlite();
  let db: SetpointDb;

  beforeAll(async () => {
    await pg.exec(migration);
    db = createSqlDb(async <T>(sql: string, params: unknown[] = []) => {
      const result = await pg.query<T>(sql, params);
      return result.rows;
    });
  });

  afterAll(async () => {
    await pg.close();
  });

  beforeEach(async () => {
    await pg.exec(`
      update public.press_lease
      set phase = 'idle', owner = null, progress = null, cancel_requested = false, lease_until = null
      where id = 1;
      delete from public.setpoint_changes;
      delete from public.meter_reads;
      delete from private.switchbot_credentials;
    `);
    await db.patchState(null, {
      mode: 'live',
      virtualSetpoint: 70,
      hold: null,
      records: [],
      schedulePhase: 'armed',
      catchupNote: null,
      catchupFrom: '2099-01-01T00:00:00.000Z',
      settings,
      deviceMap: { up: bot('up'), down: bot('down'), meter: { ...bot('meter'), deviceType: 'Meter' } },
    });
  });

  it('keeps a single lease and lets an expired lease be taken', async () => {
    expect(await db.acquireLease('one', 60)).toBe(true);
    expect(await db.acquireLease('two', 60)).toBe(false);
    await pg.exec(`update public.press_lease set lease_until = now() - interval '1 second' where id = 1`);
    expect(await db.acquireLease('two', 60)).toBe(true);
    await db.releaseLease('two');
    const lease = await db.readLease();
    expect(lease.phase).toBe('idle');
  });

  it('commits each successful press onto the shared setpoint row', async () => {
    const presses: string[] = [];
    const result = await executeSharedPress(db, {
      target: 72,
      source: { kind: 'set-to' },
      owner: 'test',
      press: async (direction) => {
        presses.push(direction);
      },
    });
    expect(result.status).toBe('done');
    expect(presses).toEqual(['up', 'up']);
    const row = await pg.query<{ virtual_setpoint: number }>(`select virtual_setpoint from public.shared_state where id = 1`);
    expect(row.rows[0]?.virtual_setpoint).toBe(72);
    const changes = await pg.query<{ setpoint: number; source: string }>(
      `select setpoint, source from public.setpoint_changes order by id`,
    );
    expect(changes.rows.map((item) => item.setpoint)).toEqual([71, 72]);
    const state = await db.readState();
    expect(state.hold?.kind).toBe('until-event');
  });

  it('does not count an ambiguous press and does not start a hold', async () => {
    const result = await executeSharedPress(db, {
      target: 71,
      source: { kind: 'manual' },
      owner: 'test',
      press: async () => {
        throw new PressOutcomeError('The response was lost.', 'ambiguous');
      },
    });
    expect(result.status).toBe('ambiguous');
    expect(result.notifyCheck).toBe(true);
    const state = await db.readState();
    expect(state.virtualSetpoint).toBe(70);
    expect(state.hold).toBeNull();
    expect(state.schedulePhase).toBe('armed');
    const changes = await pg.query<{ n: number }>(`select count(*)::int as n from public.setpoint_changes`);
    expect(changes.rows[0]?.n).toBe(0);
  });

  it('does not start a hold when the press fails or the target is already showing', async () => {
    const failed = await executeSharedPress(db, {
      target: 71,
      source: { kind: 'manual' },
      owner: 'test',
      press: async () => {
        throw new PressOutcomeError('The up bot did not respond.', 'rejected');
      },
    });
    expect(failed.status).toBe('failed');
    expect((await db.readState()).hold).toBeNull();
    const already = await executeSharedPress(db, {
      target: 70,
      source: { kind: 'preset', label: 'Home' },
      owner: 'test',
      press: async () => {
        throw new Error('should not press');
      },
    });
    expect(already.status).toBe('already');
    expect((await db.readState()).hold).toBeNull();
  });

  it('cancels before the first press is sent', async () => {
    let presses = 0;
    const pending = executeSharedPress(db, {
      target: 73,
      source: { kind: 'manual' },
      owner: 'test',
      armMs: 120,
      press: async () => {
        presses += 1;
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    await db.requestCancel();
    const result = await pending;
    expect(result.status).toBe('cancelled');
    expect(presses).toBe(0);
    const state = await db.readState();
    expect(state.virtualSetpoint).toBe(70);
    expect(state.hold).toBeNull();
  });

  it('finishes the in-flight press, skips the rest, and then holds', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let presses = 0;
    const pending = executeSharedPress(db, {
      target: 72,
      source: { kind: 'set-to' },
      owner: 'test',
      press: async () => {
        presses += 1;
        if (presses === 1) {
          await gate;
        }
      },
    });
    let entered = false;
    for (let attempt = 0; attempt < 40 && !entered; attempt += 1) {
      entered = presses === 1;
      if (!entered) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    expect(entered).toBe(true);
    await db.requestCancel();
    let finishing = false;
    let lastProgress: unknown = null;
    for (let attempt = 0; attempt < 40 && !finishing; attempt += 1) {
      const lease = await db.readLease();
      lastProgress = lease.progress;
      finishing = lease.progress?.label === 'finishing';
      if (!finishing) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    expect(lastProgress).toMatchObject({ label: 'finishing' });
    release();
    const result = await pending;
    expect(result.status).toBe('cancelled');
    expect(presses).toBe(1);
    const state = await db.readState();
    expect(state.virtualSetpoint).toBe(71);
    expect(state.hold).not.toBeNull();
  });

  it('applies only the latest due target and records the miss', async () => {
    await db.patchState(null, {
      virtualSetpoint: 68,
      catchupFrom: '2026-11-11T01:00:00.000Z',
    });
    const presses: string[] = [];
    const outcome = await runSchedulerTick(db, {
      now: () => wednesdayMorning,
      press: async (direction) => {
        presses.push(direction);
      },
    });
    expect(outcome.note).toBe('Sleep was missed, applied Wake.');
    expect(presses).toEqual(['up', 'up']);
    const state = await db.readState();
    expect(state.virtualSetpoint).toBe(70);
    expect(state.records.some((record) => record.label === 'Sleep' && record.status === 'missed')).toBe(true);
    expect(state.records.some((record) => record.label === 'Wake' && record.status === 'done-late')).toBe(true);
    expect(state.schedulePhase).toBe('armed');
  });

  it('honors a skip, an undo, and a run-now mark', async () => {
    await db.patchState(null, { catchupFrom: '2026-11-11T11:00:00.000Z', virtualSetpoint: 68 });
    const skipped = await handleMcp(db, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'skip_wake', arguments: { eventId: 'default-wake', date: '2026-11-11' } },
    }, { now: () => wednesdayMorning, armMs: 0, press: async () => undefined });
    const skippedText = textOf(skipped);
    expect(skippedText).toContain('default-wake');
    const quiet = await runSchedulerTick(db, { now: () => wednesdayMorning, press: async () => undefined });
    expect(quiet.apply).toBeNull();
    const state = await db.readState();
    const skip = state.records.find((record) => record.eventId === 'default-wake' && record.status === 'skipped');
    expect(skip).toBeTruthy();
    await handleMcp(db, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'skip_wake', arguments: { undoKey: skip?.key } },
    }, { now: () => wednesdayMorning, armMs: 0 });
    expect((await db.readState()).records.some((record) => record.status === 'skipped')).toBe(false);

    await db.patchState(null, { records: [], virtualSetpoint: 68 });
    await handleMcp(db, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'skip_wake', arguments: { eventId: 'default-wake', date: '2026-11-11' } },
    }, { now: () => wednesdayMorning, armMs: 0 });
    const ran = await handleMcp(db, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'run_schedule_now', arguments: { eventId: 'default-wake' } },
    }, {
      now: () => wednesdayMorning,
      armMs: 0,
      press: async () => undefined,
    });
    expect(textOf(ran)).toContain('done-late');
    const after = await db.readState();
    expect(after.virtualSetpoint).toBe(70);
    expect(after.hold).toBeNull();
    const again = await runSchedulerTick(db, {
      now: () => wednesdayMorning,
      press: async () => {
        throw new Error('should not press a finished wake');
      },
    });
    expect(again.apply).toBeNull();
  });

  it('resets the catch-up cursor for time edits only', async () => {
    await db.patchState(null, { catchupFrom: '2026-11-01T00:00:00.000Z' });
    const renamed = await editScheduleEvent(db, 'default-wake', { label: 'Morning' }, wednesdayMorning);
    expect(renamed.catchupFrom).toContain('2026-11-01');
    const moved = await editScheduleEvent(db, 'default-wake', { hour: 7 }, wednesdayMorning);
    expect(Date.parse(moved.catchupFrom ?? '')).toBe(wednesdayMorning.getTime());
    const reordered = await editScheduleEvent(db, 'default-wake', { label: 'Wake' }, wednesdayMorning);
    expect(Date.parse(reordered.catchupFrom ?? '')).toBe(wednesdayMorning.getTime());
  });

  it('stores meter reads and rolls raw rows older than 30 days', async () => {
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    const recent = new Date().toISOString();
    await db.insertRead({ at: old, temperatureF: 68, humidity: 40, co2Ppm: 800 });
    await db.insertRead({ at: recent, temperatureF: 70, humidity: 42, co2Ppm: 900 });
    const pruned = await db.pruneReads();
    expect(pruned.deleted).toBe(1);
    expect(pruned.rolled).toBe(1);
    const rows = await pg.query<{ granularity: string; n: number }>(
      `select granularity, count(*)::int as n from public.meter_reads group by granularity order by granularity`,
    );
    expect(rows.rows).toEqual([
      { granularity: 'hour', n: 1 },
      { granularity: 'raw', n: 1 },
    ]);
    const listed = await db.listReads(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
    expect(listed).toHaveLength(1);
    expect(listed[0]?.co2Ppm).toBe(900);
  });

  it('serves MCP tools through the same press path and rejects a missing key', async () => {
    const listed = await handleMcp(db, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const names = ((listed.result as { tools: { name: string }[] }).tools).map((tool) => tool.name);
    expect(names).toEqual([
      'set_to',
      'nudge',
      'read_room',
      'room_history',
      'show_schedule',
      'edit_schedule',
      'skip_wake',
      'run_schedule_now',
      'status',
    ]);
    const set = await handleMcp(db, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'set_to', arguments: { temperatureF: 72 } },
    }, { armMs: 0, press: async () => undefined });
    expect(textOf(set)).toContain('done');
    const row = await pg.query<{ virtual_setpoint: number }>(`select virtual_setpoint from public.shared_state where id = 1`);
    expect(row.rows[0]?.virtual_setpoint).toBe(72);
    const room = await handleMcp(db, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'read_room', arguments: {} },
    }, {
      readMeter: async () => ({ temperatureF: 69, humidity: 41, co2Ppm: 700 }),
    });
    expect(textOf(room)).toContain('700');
    const reads = await pg.query<{ n: number }>(`select count(*)::int as n from public.meter_reads`);
    expect(reads.rows[0]?.n).toBe(1);

    const env = { anonKey: 'anon-placeholder', cronSecret: 'cron-placeholder', mcpKey: 'mcp-placeholder' };
    const denied = await handleMcpRequest(new Request('http://local/mcp', { method: 'POST', body: '{}' }), { db, env });
    expect(denied.status).toBe(401);
    const allowed = await handleMcpRequest(
      new Request('http://local/mcp', {
        method: 'POST',
        headers: { Authorization: 'Bearer mcp-placeholder', 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/list' }),
      }),
      { db, env, pressDevice: async () => undefined },
    );
    expect(allowed.status).toBe(200);
  });

  it('ignores an unversioned setpoint write and accepts a matching version', async () => {
    const env = { anonKey: 'anon-placeholder', mcpKey: 'mcp-placeholder', cronSecret: 'cron-placeholder' };
    const headers = { apikey: 'anon-placeholder', 'Content-Type': 'application/json' };
    const stale = await handleState(
      new Request('http://local/state', { method: 'PUT', headers, body: JSON.stringify({ version: 0, virtualSetpoint: 60 }) }),
      { db, env },
    );
    expect(stale.status).toBe(200);
    expect((await stale.json()).virtualSetpoint).toBe(70);
    const current = await db.readState();
    const saved = await handleState(
      new Request('http://local/state', {
        method: 'PUT',
        headers,
        body: JSON.stringify({ version: current.version, virtualSetpoint: 64, roomLabel: 'Office' }),
      }),
      { db, env },
    );
    const body = await saved.json();
    expect(body.virtualSetpoint).toBe(64);
    expect(body.roomLabel).toBe('Office');
    const conflict = await handleState(
      new Request('http://local/state', {
        method: 'PUT',
        headers,
        body: JSON.stringify({ version: current.version, roomLabel: 'Nope' }),
      }),
      { db, env },
    );
    expect(conflict.status).toBe(409);
  });

  it('stores credentials without echoing them and runs the meter and tick gates', async () => {
    const env = { anonKey: 'anon-placeholder', cronSecret: 'cron-placeholder', mcpKey: 'mcp-placeholder' };
    const headers = { apikey: 'anon-placeholder', 'Content-Type': 'application/json' };
    const saved = await handleCredentials(
      new Request('http://local/credentials', {
        method: 'POST',
        headers,
        body: JSON.stringify({ token: 'placeholder-token', secret: 'placeholder-secret' }),
      }),
      { db, env },
    );
    expect(await saved.text()).toBe('{"ok":true}');
    const stored = await db.readCredentials();
    expect(stored?.token).toBe('placeholder-token');
    expect(stored?.secret).toBe('placeholder-secret');

    const meter = await handleMeter(
      new Request('http://local/meter', { method: 'POST', headers: { 'x-setpoint-cron-secret': 'cron-placeholder' } }),
      {
        db,
        env,
        readMeterDevice: async () => ({ temperatureF: 67, humidity: 39, co2Ppm: 650 }),
      },
    );
    expect((await meter.json()).sample.co2Ppm).toBe(650);

    await db.patchState(null, { virtualSetpoint: 68, catchupFrom: '2026-11-11T01:00:00.000Z' });
    const tick = await handleTick(
      new Request('http://local/tick', { method: 'POST', headers: { 'x-setpoint-cron-secret': 'cron-placeholder' } }),
      { db, env, now: () => wednesdayMorning, pressDevice: async () => undefined },
    );
    const body = await tick.json();
    expect(body.note).toBe('Sleep was missed, applied Wake.');
    const denied = await handleTick(new Request('http://local/tick', { method: 'POST' }), { db, env });
    expect(denied.status).toBe(401);
  });
});

describe('rest client', () => {
  it('calls the service-role RPC with the function arguments', async () => {
    const calls: { url: string; body: string; authorization: string }[] = [];
    const db = createRestDb({
      url: 'http://db.local',
      serviceRoleKey: 'service-placeholder',
      fetchImpl: async (input, init) => {
        const headers = new Headers(init?.headers);
        calls.push({
          url: String(input),
          body: String(init?.body ?? ''),
          authorization: headers.get('authorization') ?? '',
        });
        if (String(input).endsWith('/read_shared_state')) {
          return new Response(JSON.stringify({
            version: 1,
            virtualSetpoint: 70,
            catchupFrom: null,
            mode: 'live',
            hold: null,
            settings,
            deviceMap: { up: null, down: null, meter: null },
            presets: [],
            events: [],
            records: [],
            schedulePhase: 'armed',
            catchupNote: null,
            roomLabel: 'Home',
          }));
        }
        return new Response('true');
      },
    });
    const state = await db.readState();
    expect(state.virtualSetpoint).toBe(70);
    expect(calls[0]?.url).toBe('http://db.local/rest/v1/rpc/read_shared_state');
    expect(calls[0]?.authorization).toBe('Bearer service-placeholder');
    await db.acquireLease('scheduler', 180);
    expect(calls[1]?.url).toContain('/acquire_press_lease');
    expect(JSON.parse(calls[1]?.body ?? '{}')).toEqual({ p_owner: 'scheduler', p_ttl_seconds: 180 });
  });
});

function textOf(message: Record<string, unknown>): string {
  const result = message.result as { content?: { text?: string }[] } | undefined;
  return result?.content?.[0]?.text ?? '';
}
