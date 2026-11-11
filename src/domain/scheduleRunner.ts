import { catchupSentence, completionStatus, planDue, upsertRecord, type HoldState, type RunRecord, type ScheduleEvent } from './schedule';

export type ScheduleLogKind = 'schedule' | 'miss' | 'cancel' | 'failure';

export type ScheduleLogLine = {
  kind: ScheduleLogKind;
  message: string;
};

export type ScheduleExecuteStatus = 'done' | 'cancelled' | 'failed' | 'refused' | 'ambiguous' | 'busy' | 'already';

export type SchedulePhase = 'armed' | 'paused-after-failure';

export async function runDueSchedule(input: {
  now: Date;
  events: ScheduleEvent[];
  records: RunRecord[];
  hold: HoldState;
  setpoint: number;
  catchupFrom: string | null;
  retryFailed: boolean;
  step?: number;
  schedulePhase?: SchedulePhase;
  execute: (target: number) => Promise<{ status: ScheduleExecuteStatus; stoppedAt: number; wanted: number; reason?: string }>;
}): Promise<{
  records: RunRecord[];
  hold: HoldState;
  log: ScheduleLogLine[];
  catchupNote: string | null;
  schedulePhase: SchedulePhase;
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
    };
  }
  const apply = decision.apply;
  if (input.setpoint === apply.targetF) {
    const missedOnly = writeMissed(input.records, decision.missed, recordedAt);
    const message = `Already at ${apply.targetF}°. No presses sent.`;
    const records = upsertRecord(missedOnly.records, {
      key: apply.key,
      eventId: apply.eventId,
      occurrenceAt: apply.at,
      label: apply.label,
      targetF: apply.targetF,
      status: 'already',
      message,
      recordedAt,
      via: decision.missed.length > 0 ? 'catch-up' : 'scheduler',
    });
    const note = decision.missed.length > 0 ? catchupSentence(decision.missed, apply.label) : null;
    const log = [...missedOnly.log];
    if (note) {
      log.push({ kind: 'schedule' as const, message: note });
    }
    log.push({
      kind: 'schedule' as const,
      message: `${apply.label} was already at ${apply.targetF}°. No presses sent.`,
    });
    return {
      records,
      hold: null,
      log,
      catchupNote: note,
      schedulePhase: 'armed',
    };
  }
  const result = await input.execute(apply.targetF);
  if (result.status === 'busy') {
    return {
      records: input.records,
      hold: input.hold,
      log: [],
      catchupNote: null,
      schedulePhase: phase,
    };
  }
  const missedOnly = writeMissed(input.records, decision.missed, recordedAt);
  const via = decision.missed.length > 0 ? 'catch-up' : 'scheduler';
  if (result.status === 'done' || result.status === 'already') {
    const status = result.status === 'already' ? 'already' : completionStatus(apply.at, input.now, via);
    const note = decision.missed.length > 0 ? catchupSentence(decision.missed, apply.label) : null;
    const message = note ?? `${apply.label} set to ${apply.targetF}°.`;
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
    };
  }
  if (result.status === 'ambiguous') {
    const message = `Check the thermostat. ${apply.label} may have moved, and the degree was not counted. Later schedules still run.`;
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
