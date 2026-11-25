import {
  alreadyCopy,
  ambiguousCopy,
  doneCopy,
  performScheduleApply,
  type ModePressReport,
  type ScheduleClimate,
  type ScheduleExecuteStatus,
} from './scheduleApply';
import { catchupSentence, completionStatus, planDue, upsertRecord, type HoldState, type RunRecord, type ScheduleEvent } from './schedule';
import type { KnownMode } from './systemMode';

export type { ScheduleExecuteStatus };

export type ScheduleLogKind = 'schedule' | 'miss' | 'cancel' | 'failure';

export type ScheduleLogLine = {
  kind: ScheduleLogKind;
  message: string;
};

export type SchedulePhase = 'armed' | 'paused-after-failure';

export async function runDueSchedule(input: {
  now: Date;
  events: ScheduleEvent[];
  records: RunRecord[];
  hold: HoldState;
  climate: ScheduleClimate;
  catchupFrom: string | null;
  retryFailed: boolean;
  step?: number;
  schedulePhase?: SchedulePhase;
  pressMode: (target: KnownMode) => Promise<ModePressReport>;
  execute: (target: number) => Promise<{ status: ScheduleExecuteStatus; stoppedAt: number; wanted: number; reason?: string }>;
}): Promise<{
  records: RunRecord[];
  hold: HoldState;
  log: ScheduleLogLine[];
  catchupNote: string | null;
  schedulePhase: SchedulePhase;
  notifyCheck: boolean;
}> {
  const decision = planDue({
    events: input.events,
    records: input.records,
    now: input.now,
    hold: input.hold,
    catchupFrom: input.catchupFrom,
    retryFailed: input.retryFailed,
    step: input.step,
  });
  const recordedAt = input.now.toISOString();
  const phase = input.schedulePhase ?? (input.retryFailed ? 'armed' : 'paused-after-failure');
  if (!decision.apply) {
    const missedOnly = writeMissed(input.records, decision.missed, recordedAt);
    return {
      records: missedOnly.records,
      hold: decision.holdExpired ? null : decision.holdNext,
      log: missedOnly.log,
      catchupNote: null,
      schedulePhase: phase,
      notifyCheck: false,
    };
  }
  const apply = decision.apply;
  const result = await performScheduleApply({
    mode: apply.mode ?? null,
    targetF: apply.targetF,
    climate: input.climate,
    pressMode: input.pressMode,
    pressTemperature: async (target) => {
      const pressed = await input.execute(target);
      return {
        status: pressed.status,
        reason: pressed.reason,
        stoppedAt: pressed.stoppedAt,
        wanted: pressed.wanted,
      };
    },
  });
  if (result.status === 'busy') {
    return {
      records: input.records,
      hold: input.hold,
      log: [],
      catchupNote: null,
      schedulePhase: phase,
      notifyCheck: false,
    };
  }
  if (result.status === 'already') {
    const missedOnly = writeMissed(input.records, decision.missed, recordedAt);
    const copy = alreadyCopy(apply.label, apply.targetF, result);
    const records = upsertRecord(missedOnly.records, {
      key: apply.key,
      eventId: apply.eventId,
      occurrenceAt: apply.at,
      label: apply.label,
      targetF: apply.targetF,
      status: 'already',
      message: copy.record,
      recordedAt,
      via: decision.missed.length > 0 ? 'catch-up' : 'scheduler',
    });
    const note = decision.missed.length > 0 ? catchupSentence(decision.missed, apply.label) : null;
    const log = [...missedOnly.log];
    if (note) {
      log.push({ kind: 'schedule' as const, message: note });
    }
    log.push({ kind: 'schedule' as const, message: copy.log });
    return {
      records,
      hold: null,
      log,
      catchupNote: note,
      schedulePhase: 'armed',
      notifyCheck: false,
    };
  }
  const missedOnly = writeMissed(input.records, decision.missed, recordedAt);
  const via = decision.missed.length > 0 ? 'catch-up' : 'scheduler';
  if (result.status === 'done') {
    const status = completionStatus(apply.at, input.now, via);
    const note = decision.missed.length > 0 ? catchupSentence(decision.missed, apply.label) : null;
    const message = note ?? doneCopy(apply.label, apply.targetF, result);
    const records = upsertRecord(missedOnly.records, {
      key: apply.key,
      eventId: apply.eventId,
      occurrenceAt: apply.at,
      label: apply.label,
      targetF: apply.targetF,
      status,
      message,
      recordedAt,
      via,
    });
    return {
      records,
      hold: null,
      log: [...missedOnly.log, { kind: 'schedule', message }],
      catchupNote: note,
      schedulePhase: 'armed',
      notifyCheck: false,
    };
  }
  if (result.status === 'cancelled') {
    const message = `Cancelled ${apply.label}. It will not run again on its own.`;
    const records = upsertRecord(missedOnly.records, {
      key: apply.key,
      eventId: apply.eventId,
      occurrenceAt: apply.at,
      label: apply.label,
      targetF: apply.targetF,
      status: 'cancelled',
      message,
      recordedAt,
      via,
    });
    return {
      records,
      hold: null,
      log: [...missedOnly.log, { kind: 'cancel', message }],
      catchupNote: null,
      schedulePhase: 'armed',
      notifyCheck: false,
    };
  }
  if (result.status === 'refused') {
    const message = result.reason ?? `${apply.label} was refused. No presses sent.`;
    const records = upsertRecord(missedOnly.records, {
      key: apply.key,
      eventId: apply.eventId,
      occurrenceAt: apply.at,
      label: apply.label,
      targetF: apply.targetF,
      status: 'refused',
      message,
      recordedAt,
      via,
      stepAtFailure: input.step,
    });
    return {
      records,
      hold: decision.holdExpired ? null : decision.holdNext,
      log: [...missedOnly.log, { kind: 'failure', message }],
      catchupNote: null,
      schedulePhase: 'armed',
      notifyCheck: false,
    };
  }
  if (result.status === 'ambiguous') {
    const message = ambiguousCopy(apply.label, result);
    const records = upsertRecord(missedOnly.records, {
      key: apply.key,
      eventId: apply.eventId,
      occurrenceAt: apply.at,
      label: apply.label,
      targetF: apply.targetF,
      status: 'ambiguous',
      message,
      recordedAt,
      via,
    });
    return {
      records,
      hold: decision.holdExpired ? null : decision.holdNext,
      log: [...missedOnly.log, { kind: 'failure', message }],
      catchupNote: null,
      schedulePhase: 'armed',
      notifyCheck: true,
    };
  }
  const message = result.reason
    ? `${result.reason}`
    : `Couldn't finish ${apply.label}. Stopped at ${result.stoppedAt}°. Wanted ${apply.targetF}°. No further presses sent.`;
  const records = upsertRecord(missedOnly.records, {
    key: apply.key,
    eventId: apply.eventId,
    occurrenceAt: apply.at,
    label: apply.label,
    targetF: apply.targetF,
    status: 'failed',
    message,
    recordedAt,
    via,
    stepAtFailure: input.step,
  });
  return {
    records,
    hold: decision.holdExpired ? null : decision.holdNext,
    log: [...missedOnly.log, { kind: 'failure', message }],
    catchupNote: null,
    schedulePhase: 'paused-after-failure',
    notifyCheck: false,
  };
}

function writeMissed(
  records: RunRecord[],
  missed: { key: string; eventId: string; at: string; label: string; targetF: number }[],
  recordedAt: string,
): { records: RunRecord[]; log: ScheduleLogLine[] } {
  let next = records;
  const log: ScheduleLogLine[] = [];
  for (const item of missed) {
    const message = `Missed ${item.label}. A later change took its place, so no presses were sent.`;
    next = upsertRecord(next, {
      key: item.key,
      eventId: item.eventId,
      occurrenceAt: item.at,
      label: item.label,
      targetF: item.targetF,
      status: 'missed',
      message,
      recordedAt,
      via: 'catch-up',
    });
    log.push({ kind: 'miss', message });
  }
  return { records: next, log };
}
