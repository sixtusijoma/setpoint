import { lowBatteries } from '../domain/batteryFetch';
import { historyQuery } from '../domain/history';
import { refusalFor, resolveActive } from '../domain/modeSetpoint';
import { applyTransition, nextSkippable, occurrenceForRunNow, occurrenceOnDate } from '../domain/occurrences';
import type { Occurrence, ScheduleEvent } from '../domain/schedule';
import { performScheduleApply } from '../domain/scheduleApply';
import { isKnownMode, modeLabel, type KnownMode } from '../domain/systemMode';
import { dayNames, formatClock } from '../domain/time';
import {
  deviceIds,
  editScheduleEvent,
  executeModePress,
  executeSharedPress,
  recalibrateModeShared,
  recalibrateShared,
  refreshBatteryCache,
  storeMeterRead,
  type PressTiming,
} from './engine';
import { importMeterCsv } from './importMeter';
import type { SetpointDb } from './sqlDb';
import type { CommandSource, LeaseView } from './types';

export const MCP_TOOLS = [
  {
    name: 'set_to',
    description: 'Set the shared thermostat setpoint to an exact Fahrenheit temperature.',
    inputSchema: { type: 'object', properties: { temperatureF: { type: 'number' } }, required: ['temperatureF'] },
  },
  {
    name: 'nudge',
    description: 'Move the setpoint up or down by one step.',
    inputSchema: { type: 'object', properties: { direction: { type: 'string', enum: ['up', 'down'] } }, required: ['direction'] },
  },
  {
    name: 'read_room',
    description: 'Read the SwitchBot meter and store the sample.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'room_history',
    description:
      'Return stored temperature, humidity, and CO2. Use span day, week, month, or year, or pass since and until as ISO timestamps. Ranges over 120 days come back as daily averages for Eastern Time days.',
    inputSchema: {
      type: 'object',
      properties: {
        span: { type: 'string', enum: ['day', 'week', 'month', 'year'] },
        since: { type: 'string', description: 'Range start, ISO timestamp. Requires until.' },
        until: { type: 'string', description: 'Range end, ISO timestamp. Requires since.' },
      },
    },
  },
  {
    name: 'import_meter_csv',
    description: 'Import a SwitchBot Meter Pro CO2 CSV export into stored room readings. Sending the same file again does not duplicate rows.',
    inputSchema: {
      type: 'object',
      properties: {
        csv: { type: 'string', description: 'CSV text from SwitchBot app, Meter Pro, Export Data.' },
      },
      required: ['csv'],
    },
  },
  {
    name: 'show_schedule',
    description:
      'Show the shared schedule, skips, and recent occurrence states. Each event says enabled or disabled. Disabled events never run. mode is heat, cool, or off when the event switches the thermostat; otherwise the event leaves the mode alone.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'edit_schedule',
    description:
      'Edit one schedule event, or create it when the id is new. Pass enabled=false to turn an event off (it stays in the list and never runs) and enabled=true to turn it back on. Time, temperature, or mode edits, and re-enabling a disabled event, reset the catch-up cursor. Days, renames, disabling, and new events do not. Pass mode heat, cool, or off to switch the thermostat when the event fires. Omit mode to leave the saved mode unchanged. Pass null so the event does not change the thermostat mode.',
    inputSchema: {
      type: 'object',
      properties: {
        eventId: { type: 'string' },
        label: { type: 'string' },
        hour: { type: 'number' },
        minute: { type: 'number' },
        targetF: { type: 'number' },
        days: { type: 'array', items: { type: 'number' }, description: 'Weekdays to run, Monday=1 through Sunday=7. Must not be empty. To stop an event running, pass enabled=false instead.' },
        enabled: { type: 'boolean', description: 'true runs the event on its days, false turns it off without changing anything else.' },
        mode: {
          type: ['string', 'null'],
          enum: ['heat', 'cool', 'off', null],
          description: 'Thermostat mode when the event fires. Omit to leave the saved mode unchanged. null leaves the thermostat mode alone.',
        },
      },
      required: ['eventId'],
    },
  },
  {
    name: 'skip_wake',
    description: 'Skip the next occurrence, or a chosen date (YYYY-MM-DD). Pass undoKey to undo.',
    inputSchema: {
      type: 'object',
      properties: { eventId: { type: 'string' }, date: { type: 'string' }, undoKey: { type: 'string' } },
    },
  },
  {
    name: 'run_schedule_now',
    description: 'Apply one schedule target now and mark that occurrence done early or late. Refuses a disabled event: enable it first with edit_schedule.',
    inputSchema: { type: 'object', properties: { eventId: { type: 'string' } }, required: ['eventId'] },
  },
  {
    name: 'set_mode',
    description:
      'Press the Mode bot until the thermostat reaches heat, off, or cool. One press moves the configured number of modes (2 by default). Refuses when the tracked mode is unknown.',
    inputSchema: {
      type: 'object',
      properties: { mode: { type: 'string', enum: ['heat', 'off', 'cool'] } },
      required: ['mode'],
    },
  },
  {
    name: 'recalibrate_mode',
    description: 'Set the tracked thermostat mode to what it is actually in right now. Presses nothing.',
    inputSchema: {
      type: 'object',
      properties: { mode: { type: 'string', enum: ['heat', 'off', 'cool'] } },
      required: ['mode'],
    },
  },
  {
    name: 'recalibrate',
    description:
      'Correct the tracked mode and the stored Heat and Cool setpoints to what the thermostat shows right now. Presses nothing. Pass any of mode, heatF, and coolF; omitted fields stay as they are. The mode must already be known, or be included in this call. temperatureF still corrects only the active setpoint and cannot be combined with the other fields.',
    inputSchema: {
      type: 'object',
      properties: {
        temperatureF: {
          type: 'number',
          description: 'Legacy: the active setpoint, in whole degrees F. Do not combine with mode, heatF, or coolF.',
        },
        mode: { type: 'string', enum: ['heat', 'off', 'cool'] },
        heatF: { type: 'number', description: 'Stored Heat setpoint, in whole degrees F.' },
        coolF: { type: 'number', description: 'Stored Cool setpoint, in whole degrees F.' },
      },
    },
  },
  {
    name: 'status',
    description:
      'Show the shared app mode, thermostat system mode, Heat and Cool setpoints, bot batteries, hold, and press lock.',
    inputSchema: { type: 'object', properties: {} },
  },
] as const;

type ToolDeps = {
  now?: () => Date;
  armMs?: number;
  timing?: PressTiming;
  press?: (direction: 'up' | 'down', signal: AbortSignal) => Promise<void>;
  pressMode?: (signal: AbortSignal) => Promise<void>;
  readMeter?: () => Promise<{ temperatureF: number; humidity: number; co2Ppm: number }>;
  readBattery?: (deviceId: string) => Promise<number | null>;
};

export async function handleMcp(db: SetpointDb, body: unknown, deps: ToolDeps = {}): Promise<Record<string, unknown>> {
  const message = body as { id?: unknown; method?: string; params?: { name?: string; arguments?: Record<string, unknown> } };
  const id = message.id ?? null;
  if (message.method === 'initialize') {
    return { jsonrpc: '2.0', id, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'setpoint', version: '1' } } };
  }
  if (message.method === 'notifications/initialized' || message.method === 'ping') {
    return { jsonrpc: '2.0', id, result: {} };
  }
  if (message.method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: MCP_TOOLS } };
  }
  if (message.method !== 'tools/call') {
    return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } };
  }
  try {
    const name = message.params?.name;
    const args = message.params?.arguments ?? {};
    const text = await callTool(db, name, args, deps);
    return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } };
  } catch (error) {
    const text = error instanceof Error ? error.message : 'Tool failed';
    return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError: true } };
  }
}

function describeEvent(event: ScheduleEvent): ScheduleEvent & { status: 'enabled' | 'disabled' } {
  return { ...event, status: event.enabled ? 'enabled' : 'disabled' };
}

function summaryLine(event: ScheduleEvent): string {
  const mode = event.mode ? ` · ${modeLabel(event.mode)}` : '';
  return `${event.label} (${event.id}): ${event.enabled ? 'ENABLED' : 'DISABLED, will not run'} · ${formatClock(event.hour, event.minute)} · ${event.targetF}°${mode} · ${dayNames(event.days)}`;
}

function scheduleModeArgument(value: unknown): KnownMode | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (isKnownMode(value)) {
    return value;
  }
  throw new Error('Mode must be heat, cool, or off, or null to leave the thermostat mode alone.');
}

async function callTool(db: SetpointDb, name: string | undefined, args: Record<string, unknown>, deps: ToolDeps): Promise<string> {
  const now = deps.now ?? (() => new Date());
  const press = deps.press ?? (async () => undefined);
  if (name === 'status') {
    const state = await db.readState();
    const lease = await db.readLease();
    const batteries = deps.readBattery
      ? await refreshBatteryCache(db, { now: now(), readBattery: deps.readBattery })
      : state.batteryCache;
    const active = resolveActive(state.systemMode, { heat: state.heatSetpoint, cool: state.coolSetpoint });
    return JSON.stringify({
      setpoint: active.status === 'active' ? active.degrees : null,
      systemMode: state.systemMode,
      heatSetpoint: state.heatSetpoint,
      coolSetpoint: state.coolSetpoint,
      mode: state.mode,
      hold: state.hold,
      phase: state.schedulePhase,
      note: state.catchupNote,
      lease: lease.phase,
      batteries,
      lowBattery: lowBatteries(batteries ?? { up: null, down: null, mode: null }).map((item) => item.slot),
      schedule: state.events.map((event) => ({ id: event.id, label: event.label, enabled: event.enabled })),
      disabledEvents: state.events.filter((event) => !event.enabled).map((event) => event.id),
    });
  }
  if (name === 'show_schedule') {
    const state = await db.readState();
    return JSON.stringify({
      events: state.events.map(describeEvent),
      summary: state.events.map(summaryLine),
      records: state.records.slice(-12),
      note: state.catchupNote,
    });
  }
  if (name === 'room_history') {
    const range = historyQuery({ span: args.span, since: args.since, until: args.until }, now());
    const reads = await db.listReads(range.since, range.until, range.bucketSeconds);
    const changes = await db.listChanges(range.since, range.until);
    return JSON.stringify({ reads, changes });
  }
  if (name === 'import_meter_csv') {
    const csv = typeof args.csv === 'string' ? args.csv : '';
    if (!csv.trim()) {
      throw new Error('Pass the CSV text in csv.');
    }
    const summary = await importMeterCsv(db, csv);
    return JSON.stringify(summary);
  }
  if (name === 'read_room') {
    if (!deps.readMeter) {
      throw new Error('No meter is configured.');
    }
    const reading = await deps.readMeter();
    const sample = { at: now().toISOString(), ...reading };
    await storeMeterRead(db, sample);
    return JSON.stringify(sample);
  }
  if (name === 'edit_schedule') {
    const eventId = String(args.eventId ?? '');
    const saved = await editScheduleEvent(db, eventId, {
      label: typeof args.label === 'string' ? args.label : undefined,
      hour: typeof args.hour === 'number' ? args.hour : undefined,
      minute: typeof args.minute === 'number' ? args.minute : undefined,
      targetF: typeof args.targetF === 'number' ? args.targetF : undefined,
      days: Array.isArray(args.days) ? args.days.map((day) => Number(day)) : undefined,
      enabled: typeof args.enabled === 'boolean' ? args.enabled : undefined,
      mode: scheduleModeArgument(args.mode),
    }, now());
    return JSON.stringify({ events: saved.events.map(describeEvent), catchupFrom: saved.catchupFrom });
  }
  if (name === 'skip_wake') {
    return JSON.stringify(await skipTool(db, args, now));
  }
  if (name === 'run_schedule_now') {
    return JSON.stringify(await runNowTool(db, String(args.eventId ?? ''), now, press, deps.pressMode, deps.timing));
  }
  if (name === 'recalibrate') {
    const saved = await recalibrateShared(db, {
      temperatureF: args.temperatureF,
      mode: args.mode,
      heatF: args.heatF,
      coolF: args.coolF,
      now,
    });
    return JSON.stringify({
      previous: saved.previous,
      setpoint: saved.setpoint,
      systemMode: saved.systemMode,
      heatSetpoint: saved.heatSetpoint,
      coolSetpoint: saved.coolSetpoint,
    });
  }
  if (name === 'recalibrate_mode') {
    const saved = await recalibrateModeShared(db, { mode: args.mode });
    return JSON.stringify({ previous: saved.previous, systemMode: saved.systemMode, setpoint: saved.setpoint });
  }
  if (name === 'set_mode') {
    if (!isKnownMode(args.mode)) {
      throw new Error('Mode must be heat, off, or cool.');
    }
    await waitForActiveCommandLease(
      db,
      (lease) => lease.progress?.kind === 'setpoint' || (lease.progress === null && lease.owner === 'mcp'),
      now,
      deps.timing,
    );
    const result = await executeModePress(db, {
      target: args.mode,
      source: { kind: 'mcp' },
      owner: 'mcp',
      now,
      timing: deps.timing,
      press: deps.pressMode ?? (async () => {
        throw new Error('Map the mode bot before changing the thermostat mode.');
      }),
    });
    return JSON.stringify(result);
  }
  if (name === 'set_to' || name === 'nudge') {
    await waitForActiveCommandLease(
      db,
      (lease) => lease.progress?.kind === 'mode' || (lease.progress === null && lease.owner === 'mcp'),
      now,
      deps.timing,
    );
    const state = await db.readState();
    const active = resolveActive(state.systemMode, { heat: state.heatSetpoint, cool: state.coolSetpoint });
    if (active.status !== 'active') {
      throw new Error(refusalFor(active) ?? 'Set the virtual setpoint first.');
    }
    const target = name === 'set_to'
      ? Number(args.temperatureF)
      : active.degrees + (args.direction === 'down' ? -state.settings.step : state.settings.step);
    const source: CommandSource = name === 'set_to' ? { kind: 'set-to' } : { kind: 'manual' };
    const result = await executeSharedPress(db, { target, source, owner: 'mcp', now, armMs: deps.armMs ?? 400, timing: deps.timing, press });
    return JSON.stringify(result);
  }
  throw new Error('Unknown tool');
}

async function skipTool(db: SetpointDb, args: Record<string, unknown>, now: () => Date): Promise<unknown> {
  const state = await db.readState();
  if (typeof args.undoKey === 'string') {
    const record = state.records.find((item) => item.key === args.undoKey);
    if (!record) {
      throw new Error('Nothing to undo.');
    }
    const occurrence: Occurrence = {
      key: record.key,
      eventId: record.eventId,
      label: record.label,
      targetF: record.targetF,
      at: record.occurrenceAt,
    };
    const moved = applyTransition(state.records, occurrence, { type: 'undo-skip' }, now().toISOString());
    if ('error' in moved) {
      throw new Error(moved.error);
    }
    await db.patchState(state.version, { records: moved.records });
    return { undone: args.undoKey };
  }
  const eventId = String(args.eventId ?? 'default-wake');
  const event = state.events.find((item) => item.id === eventId);
  if (!event) {
    throw new Error('No schedule event with that id.');
  }
  if (!event.enabled) {
    throw new Error(`${event.label} is disabled, so it has nothing to skip. Enable it with edit_schedule first.`);
  }
  const when = typeof args.date === 'string'
    ? occurrenceOnDate(state.events, eventId, args.date)
    : nextSkippable(state.events, state.records, eventId, now());
  if (!when) {
    throw new Error('That event has no upcoming occurrence.');
  }
  const moved = applyTransition(state.records, when, { type: 'skip' }, now().toISOString());
  if ('error' in moved) {
    throw new Error(moved.error);
  }
  await db.patchState(state.version, { records: moved.records });
  return { skipped: when.key, label: event.label };
}

async function waitForActiveCommandLease(
  db: SetpointDb,
  shouldWait: (lease: LeaseView) => boolean,
  now: () => Date,
  timing?: PressTiming,
): Promise<void> {
  const clock = timing?.clock ?? (() => Date.now());
  const pause = timing?.clock && timing?.sleep
    ? (ms: number) => timing.sleep!(ms, () => false)
    : (ms: number) => new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms));
  const maxWaitMs = 30_000;
  const deadline = Math.min(clock() + maxWaitMs, timing?.deadlineAt ?? clock() + maxWaitMs);
  while (clock() < deadline) {
    const lease = await db.readLease();
    if (lease.phase !== 'running' || !lease.leaseUntil || Date.parse(lease.leaseUntil) <= now().getTime()) {
      return;
    }
    if (!shouldWait(lease)) {
      return;
    }
    await pause(25);
  }
}

async function runNowTool(
  db: SetpointDb,
  eventId: string,
  now: () => Date,
  press: (direction: 'up' | 'down', signal: AbortSignal) => Promise<void>,
  pressMode: ((signal: AbortSignal) => Promise<void>) | undefined,
  pressTiming?: PressTiming,
): Promise<unknown> {
  await waitForActiveCommandLease(
    db,
    (lease) => lease.progress?.kind === 'mode' || (lease.progress === null && lease.owner === 'mcp'),
    now,
    pressTiming,
  );
  const state = await db.readState();
  const event = state.events.find((item) => item.id === eventId);
  if (!event) {
    throw new Error('That schedule cannot run right now.');
  }
  if (!event.enabled) {
    throw new Error(`${event.label} is disabled, so it was not run. Enable it with edit_schedule (enabled=true) first.`);
  }
  const active = resolveActive(state.systemMode, { heat: state.heatSetpoint, cool: state.coolSetpoint });
  if (!event.mode && active.status !== 'active') {
    throw new Error(refusalFor(active) ?? 'That schedule cannot run right now.');
  }
  const when = occurrenceForRunNow(state.events, eventId, now());
  if (!when) {
    throw new Error('That event has no occurrence to mark.');
  }
  const previous = active.status === 'active' ? active.degrees : undefined;
  const result = await performScheduleApply({
    mode: event.mode ?? null,
    targetF: event.targetF,
    climate: { systemMode: state.systemMode, heatSetpoint: state.heatSetpoint, coolSetpoint: state.coolSetpoint },
    pressMode: async (target) => {
      const pressed = await executeModePress(db, {
        target,
        source: { kind: 'mcp' },
        owner: 'mcp',
        now,
        timing: pressTiming,
        press: pressMode ?? (async () => {
          throw new Error('Map the mode bot before changing the thermostat mode.');
        }),
      });
      return { status: pressed.status, reason: pressed.reason, reached: pressed.systemMode };
    },
    pressTemperature: async (target) => {
      const pressed = await executeSharedPress(db, {
        target,
        source: { kind: 'run-now', eventId: event.id, label: event.label, occurrenceKey: when.key },
        owner: 'mcp',
        now,
        armMs: 0,
        timing: pressTiming,
        press,
      });
      return { status: pressed.status, reason: pressed.reason, stoppedAt: pressed.stoppedAt, wanted: pressed.wanted };
    },
  });
  if (result.status !== 'done' && result.status !== 'already') {
    return {
      status: result.status,
      stoppedAt: result.stoppedAt,
      wanted: result.wanted,
      reason: result.reason,
      notifyCheck: result.notifyCheck,
    };
  }
  const latest = await db.readState();
  const timing = now().getTime() < Date.parse(when.at) ? 'early' : 'late';
  const moved = applyTransition(
    latest.records,
    when,
    { type: 'run-now', when: timing },
    now().toISOString(),
    { via: 'run-now', previousSetpoint: previous },
  );
  if (!('error' in moved)) {
    await db.patchState(latest.version, { records: moved.records, hold: null });
  }
  return { ...result, occurrence: when.key, timing: timing === 'early' ? 'done-early' : 'done-late' };
}

export function capturedPress(map: { upId: string | null; downId: string | null }, press: (id: string, signal: AbortSignal) => Promise<void>) {
  return (direction: 'up' | 'down', signal: AbortSignal) => {
    const id = direction === 'up' ? map.upId : map.downId;
    if (!id) {
      return Promise.reject(new Error('Map both bots before changing the temperature.'));
    }
    return press(id, signal);
  };
}

export { deviceIds };
