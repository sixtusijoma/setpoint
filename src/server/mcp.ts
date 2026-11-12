import { applyTransition, nextSkippable, occurrenceForRunNow, occurrenceOnDate } from '../domain/occurrences';
import type { Occurrence } from '../domain/schedule';
import { deviceIds, editScheduleEvent, executeSharedPress, storeMeterRead, type PressTiming } from './engine';
import type { SetpointDb } from './sqlDb';
import type { CommandSource } from './types';

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
    description: 'Return stored temperature, humidity, and CO2 for a day or a week.',
    inputSchema: { type: 'object', properties: { span: { type: 'string', enum: ['day', 'week'] } } },
  },
  {
    name: 'show_schedule',
    description: 'Show the shared schedule, skips, and recent occurrence states.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'edit_schedule',
    description: 'Edit one schedule event. Time or temperature edits reset the catch-up cursor. Renames and reorders do not.',
    inputSchema: {
      type: 'object',
      properties: {
        eventId: { type: 'string' },
        label: { type: 'string' },
        hour: { type: 'number' },
        minute: { type: 'number' },
        targetF: { type: 'number' },
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
    description: 'Apply one schedule target now and mark that occurrence done early or late.',
    inputSchema: { type: 'object', properties: { eventId: { type: 'string' } }, required: ['eventId'] },
  },
  {
    name: 'status',
    description: 'Show the shared setpoint, mode, hold, and press lock.',
    inputSchema: { type: 'object', properties: {} },
  },
] as const;

type ToolDeps = {
  now?: () => Date;
  armMs?: number;
  timing?: PressTiming;
  press?: (direction: 'up' | 'down', signal: AbortSignal) => Promise<void>;
  readMeter?: () => Promise<{ temperatureF: number; humidity: number; co2Ppm: number }>;
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

async function callTool(db: SetpointDb, name: string | undefined, args: Record<string, unknown>, deps: ToolDeps): Promise<string> {
  const now = deps.now ?? (() => new Date());
  const press = deps.press ?? (async () => undefined);
  if (name === 'status') {
    const state = await db.readState();
    const lease = await db.readLease();
    return JSON.stringify({
      setpoint: state.virtualSetpoint,
      mode: state.mode,
      hold: state.hold,
      phase: state.schedulePhase,
      note: state.catchupNote,
      lease: lease.phase,
    });
  }
  if (name === 'show_schedule') {
    const state = await db.readState();
    return JSON.stringify({ events: state.events, records: state.records.slice(-12), note: state.catchupNote });
  }
  if (name === 'room_history') {
    const span = args.span === 'week' ? 7 : 1;
    const since = new Date(now().getTime() - span * 24 * 60 * 60 * 1000).toISOString();
    const reads = await db.listReads(since);
    const changes = await db.listChanges(since);
    return JSON.stringify({ reads, changes });
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
    }, now());
    return JSON.stringify({ events: saved.events, catchupFrom: saved.catchupFrom });
  }
  if (name === 'skip_wake') {
    return JSON.stringify(await skipTool(db, args, now));
  }
  if (name === 'run_schedule_now') {
    return JSON.stringify(await runNowTool(db, String(args.eventId ?? ''), now, press, deps.timing));
  }
  if (name === 'set_to' || name === 'nudge') {
    const state = await db.readState();
    if (state.virtualSetpoint === null) {
      throw new Error('Set the virtual setpoint first.');
    }
    const target = name === 'set_to'
      ? Number(args.temperatureF)
      : state.virtualSetpoint + (args.direction === 'down' ? -state.settings.step : state.settings.step);
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

async function runNowTool(
  db: SetpointDb,
  eventId: string,
  now: () => Date,
  press: (direction: 'up' | 'down', signal: AbortSignal) => Promise<void>,
  pressTiming?: PressTiming,
): Promise<unknown> {
  const state = await db.readState();
  const event = state.events.find((item) => item.id === eventId);
  if (!event || state.virtualSetpoint === null) {
    throw new Error('That schedule cannot run right now.');
  }
  const when = occurrenceForRunNow(state.events, eventId, now());
  if (!when) {
    throw new Error('That event has no occurrence to mark.');
  }
  const result = await executeSharedPress(db, {
    target: event.targetF,
    source: { kind: 'run-now', eventId: event.id, label: event.label, occurrenceKey: when.key },
    owner: 'mcp',
    now,
    armMs: 0,
    timing: pressTiming,
    press,
  });
  if (result.status !== 'done' && result.status !== 'already') {
    return result;
  }
  const latest = await db.readState();
  const timing = now().getTime() < Date.parse(when.at) ? 'early' : 'late';
  const moved = applyTransition(
    latest.records,
    when,
    { type: 'run-now', when: timing },
    now().toISOString(),
    { via: 'run-now', previousSetpoint: state.virtualSetpoint },
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
