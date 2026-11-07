import type { ExecuteResult } from '@/domain/execute';
import {
  planDue,
  upsertRecord,
  type HoldState,
  type RunRecord,
  type ScheduleEvent,
} from '@/domain/schedule';
import { formatInstant } from '@/domain/time';

export type ScheduleLogKind = 'schedule' | 'miss' | 'cancel' | 'failure';

export type ScheduleLogLine = {
  kind: ScheduleLogKind;
  message: string;
};

export async function runDueSchedule(input: {
  now: Date;
  events: ScheduleEvent[];
  records: RunRecord[];
  hold: HoldState;
  setpoint: number;
  catchupFrom: string | null;
  retryFailed: boolean;
  execute: (target: number) => Promise<Pick<ExecuteResult, 'status' | 'stoppedAt' | 'wanted'>>;
}): Promise<{ records: RunRecord[]; hold: HoldState; log: ScheduleLogLine[] }> {
  const decision = planDue({
    events: input.events,
    records: input.records,
    now: input.now,
    hold: input.hold,
    catchupFrom: input.catchupFrom,
    retryFailed: input.retryFailed,
  });
  const recordedAt = input.now.toISOString();
  let records = input.records;
  const log: ScheduleLogLine[] = [];
  for (const missed of decision.missed) {
    const message = `Missed ${missed.label} · ${formatInstant(missed.at)}. A later change took its place, so no presses were sent.`;
    records = upsertRecord(records, {
      key: missed.key,
      eventId: missed.eventId,
      occurrenceAt: missed.at,
      label: missed.label,
      targetF: missed.targetF,
      status: 'missed',
      message,
      recordedAt,
    });
    log.push({ kind: 'miss', message });
  }
  const nextHold = decision.holdExpired ? null : input.hold;
  if (!decision.apply) {
    return { records, hold: nextHold, log };
  }
  const apply = decision.apply;
  if (input.setpoint === apply.targetF) {
    const message = `Already at ${apply.targetF}°. No presses sent.`;
    records = upsertRecord(records, {
      key: apply.key,
      eventId: apply.eventId,
      occurrenceAt: apply.at,
      label: apply.label,
      targetF: apply.targetF,
      status: 'already',
      message,
      recordedAt,
    });
    log.push({ kind: 'schedule', message: `${apply.label} was already at ${apply.targetF}°. No presses sent.` });
    return { records, hold: nextHold, log };
  }
  const result = await input.execute(apply.targetF);
  if (result.status === 'done') {
    const message = `${apply.label} set to ${apply.targetF}°.`;
    records = upsertRecord(records, {
      key: apply.key,
      eventId: apply.eventId,
      occurrenceAt: apply.at,
      label: apply.label,
      targetF: apply.targetF,
      status: 'ran',
      message,
      recordedAt,
    });
    log.push({ kind: 'schedule', message });
    return { records, hold: nextHold, log };
  }
  if (result.status === 'cancelled') {
    const message = `Cancelled ${apply.label}. It will not run again on its own.`;
    records = upsertRecord(records, {
      key: apply.key,
      eventId: apply.eventId,
      occurrenceAt: apply.at,
      label: apply.label,
      targetF: apply.targetF,
      status: 'cancelled',
      message,
      recordedAt,
    });
    log.push({ kind: 'cancel', message });
    return { records, hold: nextHold, log };
  }
  const message = `Couldn't finish ${apply.label}. Stopped at ${result.stoppedAt}°. Wanted ${apply.targetF}°. No further presses sent.`;
  records = upsertRecord(records, {
    key: apply.key,
    eventId: apply.eventId,
    occurrenceAt: apply.at,
    label: apply.label,
    targetF: apply.targetF,
    status: 'failed',
    message,
    recordedAt,
  });
  log.push({ kind: 'failure', message });
  return { records, hold: nextHold, log };
}
