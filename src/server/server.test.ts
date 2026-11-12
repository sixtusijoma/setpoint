import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { PRESS_SPACING_MS, PressOutcomeError } from '../domain/pressSession';
import { SWITCHBOT_TIMEOUT_MS } from '../devices/switchbot';
import { hashAppKey, type ServerEnv } from './env';
import { editScheduleEvent, executeSharedPress, runSchedulerTick, SERVER_WALL_CLOCK_MS, serverDeadline } from './engine';
import {
  APP_KEY_HEADER,
  handleCredentials,
  handleDevices,
  handleHistory,
  handleImportMeter,
  handleMcpRequest,
  handleMeter,
  handlePress,
  handlePrune,
  handleRecalibrate,
  handleSession,
  handleState,
  handleTick,
} from './http';
import { handleMcp } from './mcp';
import { createRestDb } from './restDb';
import { defaultEvents } from '../domain/schedule';
import { createSqlDb, type SetpointDb } from './sqlDb';

const migration = [
  'supabase/migrations/20261111120000_setpoint.sql',
  'supabase/migrations/20261112120000_meter_import.sql',
  'supabase/migrations/20261112180000_setpoint_change_pages.sql',
]
  .map((file) => readFileSync(path.join(process.cwd(), file), 'utf8'))
  .join('\n');

const bot = (id: string) => ({
  id,
  name: id,
  deviceType: 'Bot',
  enableCloudService: true,
  hubDeviceId: 'hub',
});

const settings = { step: 1, delayMs: 0, minF: 50, maxF: 85, pressCap: 15, wakeFirst: false };
const wednesdayMorning = new Date('2026-11-11T15:00:00.000Z');

const gaps: number[] = [];
const fast = {
  sleep: async (ms: number, isCancelled: () => boolean) => {
    gaps.push(ms);
    return isCancelled();
  },
};

describe('shared server', () => {
  const pg = new PGlite();
  let db: SetpointDb;
  let appKey = '';
  let appKeyHash: Uint8Array<ArrayBufferLike> = new Uint8Array();

  beforeAll(async () => {
    appKey = `k-${crypto.randomUUID()}`;
    appKeyHash = await hashAppKey(appKey);
    await pg.exec(migration);
    db = createSqlDb(async <T>(sql: string, params: unknown[] = []) => {
      const result = await pg.query<T>(sql, params);
      return result.rows;
    });
  });

  function appEnv(extra: Partial<ServerEnv> = {}): ServerEnv {
    return {
      appKeyHash,
      cronSecret: 'cron-placeholder',
      mcpKey: 'mcp-placeholder',
      ...extra,
    };
  }

  function appHeaders(extra: Record<string, string> = {}): Record<string, string> {
    return { [APP_KEY_HEADER]: appKey, 'Content-Type': 'application/json', ...extra };
  }

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
      events: defaultEvents(),
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
      timing: fast,
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
      timing: fast,
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
      timing: fast,
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
      timing: fast,
      press: async () => {
        throw new Error('should not press');
      },
    });
    expect(already.status).toBe('already');
    expect((await db.readState()).hold).toBeNull();
  });

  it('spaces shared presses per direction for set_to, nudge, and the schedule', async () => {
    gaps.length = 0;
    const down = await executeSharedPress(db, {
      target: 65,
      source: { kind: 'set-to' },
      owner: 'test',
      timing: fast,
      press: async () => undefined,
    });
    expect(down.status).toBe('done');
    expect(gaps).toEqual([5000, 5000, 5000, 5000]);

    gaps.length = 0;
    await db.patchState(null, { hold: null });
    const up = await handleMcp(db, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'set_to', arguments: { temperatureF: 68 } },
    }, { armMs: 0, timing: fast, press: async () => undefined });
    expect(textOf(up)).toContain('"status":"done"');
    expect(gaps).toEqual([6000, 6000]);

    gaps.length = 0;
    await db.patchState(null, { hold: null, virtualSetpoint: 68, catchupFrom: '2026-11-11T01:00:00.000Z' });
    const tick = await runSchedulerTick(db, { now: () => wednesdayMorning, timing: fast, press: async () => undefined });
    expect(tick.apply).not.toBeNull();
    expect(gaps).toEqual([6000]);
  });

  it('stops a long run before the server time limit and keeps the presses it sent', async () => {
    let clock = 0;
    const presses: string[] = [];
    const result = await executeSharedPress(db, {
      target: 79,
      source: { kind: 'set-to' },
      owner: 'test',
      timing: {
        clock: () => clock,
        deadlineAt: 30_000,
        sleep: async (ms) => {
          clock += ms;
          return false;
        },
      },
      press: async (direction) => {
        presses.push(direction);
        clock += 1000;
      },
    });
    expect(presses).toHaveLength(3);
    expect(result.status).toBe('failed');
    expect(result.stoppedAt).toBe(73);
    expect(result.reason).toContain('Out of server time after 3 of 9 presses');
    const state = await db.readState();
    expect(state.virtualSetpoint).toBe(73);
    const changes = await pg.query<{ n: number }>(`select count(*)::int as n from public.setpoint_changes`);
    expect(changes.rows[0]?.n).toBe(3);
    expect((await db.readLease()).phase).toBe('idle');
  });

  it('leaves room for a nine-press run up inside the worker limit', () => {
    const budget = serverDeadline(0);
    const typicalPressMs = 2000;
    const lastPressStarts = 8 * (typicalPressMs + PRESS_SPACING_MS.up);
    expect(budget).toBeLessThanOrEqual(SERVER_WALL_CLOCK_MS - 10_000);
    expect(lastPressStarts + SWITCHBOT_TIMEOUT_MS).toBeLessThan(budget);
  });

  it('cancels before the first press is sent', async () => {
    let presses = 0;
    const pending = executeSharedPress(db, {
      target: 73,
      source: { kind: 'manual' },
      owner: 'test',
      timing: fast,
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
      timing: fast,
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
      timing: fast,
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
    }, { now: () => wednesdayMorning, armMs: 0, timing: fast, press: async () => undefined });
    const skippedText = textOf(skipped);
    expect(skippedText).toContain('default-wake');
    const quiet = await runSchedulerTick(db, { now: () => wednesdayMorning, timing: fast, press: async () => undefined });
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
      timing: fast,
      press: async () => undefined,
    });
    expect(textOf(ran)).toContain('done-late');
    const after = await db.readState();
    expect(after.virtualSetpoint).toBe(70);
    expect(after.hold).toBeNull();
    const again = await runSchedulerTick(db, {
      now: () => wednesdayMorning,
      timing: fast,
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
    const daysOnly = await editScheduleEvent(db, 'default-wake', { days: [1, 2, 3, 4, 5] }, wednesdayMorning);
    expect(daysOnly.catchupFrom).toContain('2026-11-01');
    expect(daysOnly.events.find((event) => event.id === 'default-wake')?.days).toEqual([1, 2, 3, 4, 5]);
    const moved = await editScheduleEvent(db, 'default-wake', { hour: 7 }, wednesdayMorning);
    expect(Date.parse(moved.catchupFrom ?? '')).toBe(wednesdayMorning.getTime());
    const reordered = await editScheduleEvent(db, 'default-wake', { label: 'Wake' }, wednesdayMorning);
    expect(Date.parse(reordered.catchupFrom ?? '')).toBe(wednesdayMorning.getTime());
  });

  it('lets MCP edit days and create an event without resetting the cursor', async () => {
    await db.patchState(null, { catchupFrom: '2026-11-01T00:00:00.000Z' });
    const days = await handleMcp(db, {
      jsonrpc: '2.0',
      id: 20,
      method: 'tools/call',
      params: { name: 'edit_schedule', arguments: { eventId: 'default-sleep', days: [7, 1, 2, 3, 4] } },
    });
    const daysBody = JSON.parse(textOf(days)) as { events: { id: string; days: number[] }[]; catchupFrom: string };
    expect(daysBody.catchupFrom).toContain('2026-11-01');
    expect(daysBody.events.find((event) => event.id === 'default-sleep')?.days).toEqual([1, 2, 3, 4, 7]);
    const created = await handleMcp(db, {
      jsonrpc: '2.0',
      id: 21,
      method: 'tools/call',
      params: {
        name: 'edit_schedule',
        arguments: { eventId: 'sleep-2', label: 'Sleep 2', hour: 0, minute: 0, targetF: 61, days: [6, 7] },
      },
    });
    const createdBody = JSON.parse(textOf(created)) as { events: { id: string; label: string; hour: number }[]; catchupFrom: string };
    expect(createdBody.catchupFrom).toContain('2026-11-01');
    expect(createdBody.events.find((event) => event.id === 'sleep-2')).toMatchObject({
      label: 'Sleep 2',
      hour: 0,
      minute: 0,
      targetF: 61,
      days: [6, 7],
      enabled: true,
    });
  });

  it('recalibrates the shared setpoint without pressing and logs the change', async () => {
    const env = appEnv();
    const before = await db.readState();
    const recalibrate = (body: unknown, headers = appHeaders()) =>
      handleRecalibrate(new Request('http://local/recalibrate', { method: 'POST', headers, body: JSON.stringify(body) }), {
        db,
        env,
        now: () => wednesdayMorning,
      });

    const denied = await handleRecalibrate(new Request('http://local/recalibrate', { method: 'POST', body: '{}' }), { db, env });
    expect(denied.status).toBe(401);

    const fraction = await recalibrate({ temperatureF: 66.5 });
    expect(fraction.status).toBe(400);
    expect((await fraction.json()).error).toBe('Temperatures are whole degrees.');
    const outside = await recalibrate({ temperatureF: 40 });
    expect(outside.status).toBe(400);
    expect((await outside.json()).error).toContain('outside 50-85°');
    expect((await db.readState()).virtualSetpoint).toBe(70);

    const saved = await recalibrate({ temperatureF: 66 });
    expect(saved.status).toBe(200);
    const body = await saved.json();
    expect(body.previous).toBe(70);
    expect(body.setpoint).toBe(66);
    const after = await db.readState();
    expect(body.version).toBe(after.version);
    expect(after.virtualSetpoint).toBe(66);
    expect(after.events).toEqual(before.events);
    expect(after.hold).toEqual(before.hold);
    expect(after.catchupFrom).toBe(before.catchupFrom);
    expect(after.records).toEqual(before.records);
    expect((await db.readLease()).phase).toBe('idle');
    const changes = await pg.query<{ setpoint: number; source: string; label: string; changed_at: Date }>(
      `select setpoint, source, label, changed_at from public.setpoint_changes order by id`,
    );
    expect(changes.rows.map(({ setpoint, source, label }) => ({ setpoint, source, label }))).toEqual([
      { setpoint: 66, source: 'recalibrated', label: 'Recalibrated · 66°' },
    ]);
    expect(new Date(changes.rows[0]?.changed_at ?? 0).toISOString()).toBe(wednesdayMorning.toISOString());
  });

  it('refuses to recalibrate while a press is running', async () => {
    const env = appEnv();
    expect(await db.acquireLease('app', 60)).toBe(true);
    const busy = await handleRecalibrate(
      new Request('http://local/recalibrate', { method: 'POST', headers: appHeaders(), body: JSON.stringify({ temperatureF: 64 }) }),
      { db, env },
    );
    expect(busy.status).toBe(409);
    expect((await busy.json()).error).toBe('A press is running. Wait for it to finish before recalibrating.');
    expect((await db.readState()).virtualSetpoint).toBe(70);
    const lease = await db.readLease();
    expect(lease.phase).toBe('running');
    expect(lease.owner).toBe('app');
    await db.releaseLease('app');
    const changes = await pg.query<{ n: number }>(`select count(*)::int as n from public.setpoint_changes`);
    expect(changes.rows[0]?.n).toBe(0);
  });

  it('recalibrates through the MCP tool without pressing', async () => {
    const pressed: string[] = [];
    const call = (temperatureF: unknown) =>
      handleMcp(db, {
        jsonrpc: '2.0',
        id: 9,
        method: 'tools/call',
        params: { name: 'recalibrate', arguments: { temperatureF } },
      }, {
        press: async (direction) => {
          pressed.push(direction);
        },
      });
    const saved = await call(68);
    expect(JSON.parse(textOf(saved))).toEqual({ previous: 70, setpoint: 68 });
    expect((await db.readState()).virtualSetpoint).toBe(68);
    const refused = await call(90);
    expect(refused.result).toMatchObject({ isError: true });
    expect(textOf(refused)).toContain('outside 50-85°');
    expect(pressed).toEqual([]);
    const changes = await pg.query<{ source: string }>(`select source from public.setpoint_changes`);
    expect(changes.rows.map((row) => row.source)).toEqual(['recalibrated']);
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
      'import_meter_csv',
      'show_schedule',
      'edit_schedule',
      'skip_wake',
      'run_schedule_now',
      'recalibrate',
      'status',
    ]);
    const set = await handleMcp(db, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'set_to', arguments: { temperatureF: 72 } },
    }, { armMs: 0, timing: fast, press: async () => undefined });
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

    const env = appEnv();
    const denied = await handleMcpRequest(new Request('http://local/mcp', { method: 'POST', body: '{}' }), { db, env });
    expect(denied.status).toBe(401);
    const allowed = await handleMcpRequest(
      new Request('http://local/mcp', {
        method: 'POST',
        headers: { Authorization: 'Bearer mcp-placeholder', 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/list' }),
      }),
      { db, env, pressDevice: async () => undefined, timing: fast },
    );
    expect(allowed.status).toBe(200);
  });

  it('ignores an unversioned setpoint write and accepts a matching version', async () => {
    const env = appEnv();
    const headers = appHeaders();
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
    const env = appEnv();
    const headers = appHeaders();
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
      { db, env, now: () => wednesdayMorning, pressDevice: async () => undefined, timing: fast },
    );
    const body = await tick.json();
    expect(body.note).toBe('Sleep was missed, applied Wake.');
    const denied = await handleTick(new Request('http://local/tick', { method: 'POST' }), { db, env });
    expect(denied.status).toBe(401);
  });

  it('requires the app key on app functions and keeps cron and mcp on their own secrets', async () => {
    const env = appEnv();
    const missing = await handleState(new Request('http://local/state'), { db, env });
    expect(missing.status).toBe(401);
    expect(await missing.text()).toBe('{"error":"Unauthorized."}');
    const wrong = await handlePress(
      new Request('http://local/press', {
        method: 'POST',
        headers: { [APP_KEY_HEADER]: 'not-the-key', 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: 71, source: { kind: 'manual' } }),
      }),
      { db, env, pressDevice: async () => undefined, timing: fast },
    );
    expect(wrong.status).toBe(401);

    const lines: string[] = [];
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        lines.push(args.map((item) => String(item)).join(' '));
      }),
    );
    const state = await handleState(new Request('http://local/state', { headers: appHeaders() }), { db, env });
    expect(state.status).toBe(200);
    const stateText = await state.text();
    expect(stateText.includes(appKey)).toBe(false);
    expect(lines.some((line) => line.includes(appKey))).toBe(false);
    for (const spy of spies) {
      spy.mockRestore();
    }

    const pressed = await handlePress(
      new Request('http://local/press', {
        method: 'POST',
        headers: appHeaders(),
        body: JSON.stringify({ target: 71, source: { kind: 'manual' } }),
      }),
      { db, env, pressDevice: async () => undefined, timing: fast },
    );
    expect(pressed.status).toBe(200);
    const session = await handleSession(new Request('http://local/session', { headers: appHeaders() }), { db, env });
    expect(session.status).toBe(200);
    const history = await handleHistory(new Request('http://local/history', { headers: appHeaders() }), { db, env });
    expect(history.status).toBe(200);
    const devices = await handleDevices(new Request('http://local/devices', { method: 'POST', headers: appHeaders() }), {
      db,
      env,
      listRemoteDevices: async () => [],
    });
    expect(devices.status).toBe(200);

    const meterByApp = await handleMeter(
      new Request('http://local/meter', { method: 'POST', headers: appHeaders() }),
      { db, env, readMeterDevice: async () => ({ temperatureF: 66, humidity: 40, co2Ppm: 610 }) },
    );
    expect(meterByApp.status).toBe(200);
    const meterDenied = await handleMeter(new Request('http://local/meter', { method: 'POST' }), { db, env });
    expect(meterDenied.status).toBe(401);

    const tickWithAppKey = await handleTick(
      new Request('http://local/tick', { method: 'POST', headers: appHeaders() }),
      { db, env },
    );
    expect(tickWithAppKey.status).toBe(401);
    const pruneWithAppKey = await handlePrune(
      new Request('http://local/prune', { method: 'POST', headers: appHeaders() }),
      { db, env },
    );
    expect(pruneWithAppKey.status).toBe(401);
    const mcpWithAppKey = await handleMcpRequest(
      new Request('http://local/mcp', { method: 'POST', headers: appHeaders(), body: '{}' }),
      { db, env },
    );
    expect(mcpWithAppKey.status).toBe(401);
  });

  it('does not emit a wildcard CORS header', async () => {
    const open = await handleState(
      new Request('http://local/state', { headers: { ...appHeaders(), origin: 'https://evil.example' } }),
      { db, env: appEnv() },
    );
    expect(open.headers.get('access-control-allow-origin')).toBeNull();
    const allowed = await handleState(
      new Request('http://local/state', { headers: { ...appHeaders(), origin: 'http://127.0.0.1:43117' } }),
      { db, env: appEnv({ webOrigin: 'http://127.0.0.1:43117' }) },
    );
    expect(allowed.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:43117');
    const preflight = await handleState(
      new Request('http://local/state', { method: 'OPTIONS', headers: { origin: 'http://127.0.0.1:43117' } }),
      { db, env: appEnv({ webOrigin: 'http://127.0.0.1:43117' }) },
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:43117');
    expect(preflight.headers.get('access-control-allow-headers')).toContain(APP_KEY_HEADER);
  });

  it('reads the room through the MCP tool with live SwitchBot credentials', async () => {
    const env = appEnv();
    const call = (id: number) =>
      handleMcpRequest(
        new Request('http://local/mcp', {
          method: 'POST',
          headers: { authorization: 'Bearer mcp-placeholder', 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'read_room', arguments: {} } }),
        }),
        { db, env, now: () => wednesdayMorning },
      );

    const noCreds = await (await call(1)).json();
    expect(noCreds.result.isError).toBe(true);
    expect(textOf(noCreds)).toBe('SwitchBot credentials are not on the server.');

    await db.saveCredentials('placeholder-token', 'placeholder-secret');
    const urls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response(JSON.stringify({
        statusCode: 100,
        message: 'success',
        body: { temperature: 20, humidity: 51, CO2: 1074, battery: 52 },
      }));
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const read = await (await call(2)).json();
      expect(read.result.isError).toBeUndefined();
      expect(JSON.parse(textOf(read))).toEqual({ at: wednesdayMorning.toISOString(), temperatureF: 68, humidity: 51, co2Ppm: 1074 });
      expect(urls).toHaveLength(1);
      expect(urls[0]).toContain('/devices/meter/status');
      expect(await db.listReads('2026-11-01T00:00:00.000Z')).toHaveLength(1);

      await db.patchState(null, { deviceMap: { up: bot('up'), down: bot('down'), meter: null } });
      const unmapped = await (await call(3)).json();
      expect(unmapped.result.isError).toBe(true);
      expect(textOf(unmapped)).toBe('No meter is mapped. Pick the meter in Settings.');
      expect(urls).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('imports a meter CSV once, skips bad rows, and keeps imported history through prune', async () => {
    const overlap = '2026-11-11T23:51:00.000Z';
    await db.insertRead({ at: overlap, temperatureF: 70, humidity: 47, co2Ppm: 740 });
    const lines = [
      'Timestamp,Temperature_Celsius(°C),Relative_Humidity(%),CO2(ppm)',
      '2026-11-11 18:51:00,21.1,47,740',
      'not-a-time,20,40,600',
    ];
    const start = Date.parse('2026-01-01T05:00:00.000Z');
    for (let index = 0; index < 900; index += 1) {
      lines.push(`${new Date(start + index * 60 * 1000).toISOString()},20,40,${600 + (index % 50)}`);
    }
    const csv = lines.join('\n');
    const env = appEnv();
    const first = await handleImportMeter(
      new Request('http://local/import-meter', {
        method: 'POST',
        headers: appHeaders(),
        body: JSON.stringify({ csv }),
      }),
      { db, env },
    );
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ inserted: 900, duplicates: 1, skipped: 1, skipReasons: ['Could not read the timestamp.'] });

    const again = await handleMcp(db, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'import_meter_csv', arguments: { csv } },
    });
    expect(JSON.parse(textOf(again))).toMatchObject({ inserted: 0, duplicates: 901, skipped: 1, skipReasons: ['Could not read the timestamp.'] });

    const emptyTool = await handleMcp(db, {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'import_meter_csv', arguments: { csv: ' ' } },
    });
    expect(emptyTool.result).toMatchObject({ isError: true });

    const oldImport = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    const oldLive = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000 + 60_000).toISOString();
    await db.importReads([{ at: oldImport, temperatureF: 60, humidity: 30, co2Ppm: 500 }]);
    await db.insertRead({ at: oldLive, temperatureF: 61, humidity: 31, co2Ppm: 501 });
    const pruned = await db.pruneReads();
    expect(pruned.deleted).toBe(1);
    const kept = await pg.query<{ origin: string; granularity: string }>(
      `select origin, granularity from public.meter_reads where read_at = $1`,
      [oldImport],
    );
    expect(kept.rows[0]).toEqual({ origin: 'import', granularity: 'raw' });
  });

  it('answers day, month, and custom history ranges', async () => {
    const now = new Date('2026-11-12T16:00:00.000Z');
    const points = [
      { at: '2026-11-12T14:00:00.000Z', co2Ppm: 111 },
      { at: '2026-11-09T16:00:00.000Z', co2Ppm: 222 },
      { at: '2026-10-23T16:00:00.000Z', co2Ppm: 333 },
      { at: '2026-10-03T16:00:00.000Z', co2Ppm: 444 },
    ];
    for (const point of points) {
      await db.insertRead({ at: point.at, temperatureF: 70, humidity: 40, co2Ppm: point.co2Ppm });
    }
    const env = appEnv();
    const month = await handleMcp(db, {
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: { name: 'room_history', arguments: { span: 'month' } },
    }, { now: () => now });
    expect(JSON.parse(textOf(month)).reads.map((row: { co2Ppm: number }) => row.co2Ppm)).toEqual([333, 222, 111]);

    const custom = await handleMcp(db, {
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: {
        name: 'room_history',
        arguments: { since: '2026-10-01T00:00:00.000Z', until: '2026-10-10T00:00:00.000Z' },
      },
    }, { now: () => now });
    expect(JSON.parse(textOf(custom)).reads.map((row: { co2Ppm: number }) => row.co2Ppm)).toEqual([444]);

    const day = await handleHistory(
      new Request('http://local/history?span=day', { headers: appHeaders() }),
      { db, env, now: () => now },
    );
    expect((await day.json()).samples.map((row: { co2Ppm: number }) => row.co2Ppm)).toEqual([111]);

    const monthHttp = await handleHistory(
      new Request('http://local/history?span=month', { headers: appHeaders() }),
      { db, env, now: () => now },
    );
    expect((await monthHttp.json()).samples.map((row: { co2Ppm: number }) => row.co2Ppm)).toEqual([333, 222, 111]);
  });

  it('pages setpoint changes newest first with a cursor and keeps the span response', async () => {
    const env = appEnv();
    const start = Date.parse('2026-01-05T12:00:00.000Z');
    for (let index = 0; index < 52; index += 1) {
      await db.insertChange({
        at: new Date(start + index * 6 * 60 * 60 * 1000).toISOString(),
        setpoint: 60 + (index % 12),
        source: index % 3 === 0 ? 'schedule' : 'manual',
        label: `Change ${index}`,
      });
    }
    const tie = new Date(start + 51 * 6 * 60 * 60 * 1000).toISOString();
    await db.insertChange({ at: tie, setpoint: 71, source: 'manual', label: 'Change 52' });
    const page = (cursor: string | null, limit = '20') => {
      const params = new URLSearchParams({ view: 'changes', limit });
      if (cursor) {
        params.set('cursor', cursor);
      }
      return handleHistory(new Request(`http://local/history?${params.toString()}`, { headers: appHeaders() }), { db, env });
    };

    const labels: string[] = [];
    const sizes: number[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 10; guard += 1) {
      const response = await page(cursor);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { changes: { label: string; at: string }[]; nextCursor: string | null };
      expect(Object.keys(body).sort()).toEqual(['changes', 'nextCursor']);
      sizes.push(body.changes.length);
      labels.push(...body.changes.map((change) => change.label));
      cursor = body.nextCursor;
      if (!cursor) {
        break;
      }
    }
    expect(sizes).toEqual([20, 20, 13]);
    expect(labels).toHaveLength(53);
    expect(new Set(labels).size).toBe(53);
    expect(labels.slice(0, 3)).toEqual(['Change 52', 'Change 51', 'Change 50']);
    expect(labels[labels.length - 1]).toBe('Change 0');

    const exact = await (await page(null, '53')).json();
    expect(exact.changes).toHaveLength(53);
    expect(exact.nextCursor).toBeNull();
    const clamped = await (await page(null, '5000')).json();
    expect(clamped.changes).toHaveLength(53);
    const tiny = await (await page(null, '0')).json();
    expect(tiny.changes).toHaveLength(1);
    const defaulted = await (await page(null, 'lots')).json();
    expect(defaulted.changes).toHaveLength(20);

    const bad = await page('not-a-cursor');
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toContain('cursor');
    const denied = await handleHistory(new Request('http://local/history?view=changes'), { db, env });
    expect(denied.status).toBe(401);

    const legacy = await handleHistory(new Request('http://local/history?span=day', { headers: appHeaders() }), {
      db,
      env,
      now: () => new Date(start + 52 * 6 * 60 * 60 * 1000),
    });
    const legacyBody = await legacy.json();
    expect(Object.keys(legacyBody).sort()).toEqual(['changes', 'samples']);
    expect(legacyBody.changes.map((change: { label: string }) => change.label).sort()).toEqual([
      'Change 48',
      'Change 49',
      'Change 50',
      'Change 51',
      'Change 52',
    ]);
  });

  it('keeps import-meter on the app key', async () => {
    const env = appEnv();
    const csv = 'Timestamp,Temperature(°F),Humidity(%),CO2\n2026-11-11 6:51 PM,70,47,740\n';
    const missing = await handleImportMeter(
      new Request('http://local/import-meter', {
        method: 'POST',
        headers: { 'Content-Type': 'text/csv' },
        body: csv,
      }),
      { db, env },
    );
    expect(missing.status).toBe(401);
    const cron = await handleImportMeter(
      new Request('http://local/import-meter', {
        method: 'POST',
        headers: { 'Content-Type': 'text/csv', 'x-setpoint-cron-secret': 'cron-placeholder' },
        body: csv,
      }),
      { db, env },
    );
    expect(cron.status).toBe(401);
    const imported = await handleImportMeter(
      new Request('http://local/import-meter', {
        method: 'POST',
        headers: { [APP_KEY_HEADER]: appKey, 'Content-Type': 'text/csv' },
        body: csv,
      }),
      { db, env },
    );
    expect(imported.status).toBe(200);
    expect(await imported.json()).toMatchObject({
      inserted: 1,
      duplicates: 0,
      skipped: 0,
      firstAt: '2026-11-11T23:51:00.000Z',
      lastAt: '2026-11-11T23:51:00.000Z',
    });
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
        if (String(input).endsWith('/import_meter_reads')) {
          return new Response(JSON.stringify({ inserted: 1 }));
        }
        if (
          String(input).endsWith('/list_meter_reads') ||
          String(input).endsWith('/list_setpoint_changes') ||
          String(input).endsWith('/list_setpoint_changes_page')
        ) {
          return new Response('[]');
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
    const inserted = await db.importReads([
      { at: '2026-04-21T17:39:04.000Z', temperatureF: 78.6, humidity: 44, co2Ppm: 677 },
    ]);
    expect(inserted).toBe(1);
    const importCall = calls.find((call) => call.url.endsWith('/import_meter_reads'));
    expect(JSON.parse(importCall?.body ?? '{}').p_rows).toEqual([
      { at: '2026-04-21T17:39:04.000Z', temperatureF: 78.6, humidity: 44, co2Ppm: 677 },
    ]);
    await db.listReads('2026-04-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z', 7200);
    const listCall = calls.find((call) => call.url.endsWith('/list_meter_reads'));
    expect(JSON.parse(listCall?.body ?? '{}')).toEqual({
      p_since: '2026-04-01T00:00:00.000Z',
      p_until: '2026-05-01T00:00:00.000Z',
      p_bucket_seconds: 7200,
    });
    const firstPage = await db.listChangesPage(null, 15);
    expect(firstPage).toEqual({ changes: [], more: false });
    await db.listChangesPage({ at: '2026-04-21T17:39:04+00:00', id: 42 }, 15);
    const pageCalls = calls.filter((call) => call.url.endsWith('/list_setpoint_changes_page'));
    expect(pageCalls.map((call) => JSON.parse(call.body))).toEqual([
      { p_before_at: null, p_before_id: null, p_limit: 16 },
      { p_before_at: '2026-04-21T17:39:04+00:00', p_before_id: 42, p_limit: 16 },
    ]);
  });
});

function textOf(message: Record<string, unknown>): string {
  const result = message.result as { content?: { text?: string }[] } | undefined;
  return result?.content?.[0]?.text ?? '';
}
