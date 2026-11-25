import { refusalFor, resolveActive, UNKNOWN_MODE_REASON, unsetReason } from './modeSetpoint';
import type { ModeStatus } from './modePress';
import { modeLabel, type KnownMode, type SystemMode } from './systemMode';

export type ScheduleExecuteStatus = 'done' | 'cancelled' | 'failed' | 'refused' | 'ambiguous' | 'busy' | 'already';

export type ScheduleClimate = {
  systemMode: SystemMode;
  heatSetpoint: number | null;
  coolSetpoint: number | null;
};

export type ModeNote =
  | { kind: 'untouched' }
  | { kind: 'already'; mode: KnownMode }
  | { kind: 'switched'; mode: KnownMode };

/** Which step produced the settled result. `none` means no press was sent. */
export type ApplyStep = 'none' | 'mode' | 'temperature';

export type ScheduleApplyResult = {
  status: ScheduleExecuteStatus;
  notifyCheck: boolean;
  reason?: string;
  stoppedAt: number;
  wanted: number;
  modeNote: ModeNote;
  step: ApplyStep;
};

export type TemperatureFollowup = { kind: 'none' } | { kind: 'set'; targetF: number };

export type ScheduleApplyState =
  | { phase: 'idle' }
  | {
      phase: 'switch-mode';
      target: KnownMode;
      followup: TemperatureFollowup;
      targetF: number;
      climate: ScheduleClimate;
    }
  | { phase: 'set-temperature'; targetF: number; modeNote: ModeNote; climate: ScheduleClimate }
  | { phase: 'settled'; result: ScheduleApplyResult };

export type ModePressReport = {
  status: ModeStatus;
  reason?: string;
  reached: SystemMode;
};

export type TemperaturePressReport = {
  status: ScheduleExecuteStatus;
  reason?: string;
  stoppedAt: number;
  wanted: number;
};

export type ScheduleApplyEvent =
  | { type: 'start'; mode: KnownMode | null; targetF: number; climate: ScheduleClimate }
  | ({ type: 'mode-result' } & ModePressReport)
  | ({ type: 'temperature-result' } & TemperaturePressReport);

export function idleScheduleApply(): ScheduleApplyState {
  return { phase: 'idle' };
}

function settled(result: ScheduleApplyResult): ScheduleApplyState {
  return { phase: 'settled', result };
}

function refused(targetF: number, reason: string, modeNote: ModeNote, step: ApplyStep): ScheduleApplyState {
  return settled({
    status: 'refused',
    notifyCheck: false,
    reason,
    stoppedAt: targetF,
    wanted: targetF,
    modeNote,
    step,
  });
}

function temperatureForMode(
  targetF: number,
  mode: 'heat' | 'cool',
  climate: ScheduleClimate,
  modeNote: ModeNote,
): ScheduleApplyState {
  const degrees = mode === 'heat' ? climate.heatSetpoint : climate.coolSetpoint;
  if (degrees === null) {
    return refused(targetF, unsetReason(mode), modeNote, modeNote.kind === 'switched' ? 'mode' : 'none');
  }
  if (degrees === targetF) {
    const step: ApplyStep = modeNote.kind === 'switched' ? 'mode' : 'none';
    const status: ScheduleExecuteStatus = modeNote.kind === 'switched' ? 'done' : 'already';
    return settled({
      status,
      notifyCheck: false,
      stoppedAt: targetF,
      wanted: targetF,
      modeNote,
      step,
    });
  }
  return { phase: 'set-temperature', targetF, modeNote, climate };
}

function temperatureFromActive(targetF: number, climate: ScheduleClimate, modeNote: ModeNote): ScheduleApplyState {
  const active = resolveActive(climate.systemMode, { heat: climate.heatSetpoint, cool: climate.coolSetpoint });
  if (active.status !== 'active') {
    return refused(targetF, refusalFor(active) ?? 'Set the virtual setpoint first.', modeNote, 'none');
  }
  if (active.degrees === targetF) {
    return settled({
      status: 'already',
      notifyCheck: false,
      stoppedAt: targetF,
      wanted: targetF,
      modeNote,
      step: 'none',
    });
  }
  return { phase: 'set-temperature', targetF, modeNote, climate };
}

function afterModeReached(
  target: KnownMode,
  followup: TemperatureFollowup,
  targetF: number,
  climate: ScheduleClimate,
  modeNote: ModeNote,
): ScheduleApplyState {
  if (target === 'off' || followup.kind === 'none') {
    const status: ScheduleExecuteStatus = modeNote.kind === 'switched' ? 'done' : 'already';
    return settled({
      status,
      notifyCheck: false,
      stoppedAt: targetF,
      wanted: targetF,
      modeNote,
      step: modeNote.kind === 'switched' ? 'mode' : 'none',
    });
  }
  return temperatureForMode(followup.targetF, target, climate, modeNote);
}

function stopFromMode(
  status: 'failed' | 'cancelled' | 'refused' | 'busy' | 'ambiguous',
  targetF: number,
  reason: string | undefined,
): ScheduleApplyState {
  return settled({
    status,
    notifyCheck: status === 'ambiguous',
    reason,
    stoppedAt: targetF,
    wanted: targetF,
    modeNote: { kind: 'untouched' },
    step: 'mode',
  });
}

export function reduceScheduleApply(state: ScheduleApplyState, event: ScheduleApplyEvent): ScheduleApplyState {
  if (event.type === 'start') {
    if (state.phase !== 'idle') {
      return state;
    }
    if (event.mode === null) {
      return temperatureFromActive(event.targetF, event.climate, { kind: 'untouched' });
    }
    if (event.climate.systemMode === 'unknown') {
      return refused(event.targetF, UNKNOWN_MODE_REASON, { kind: 'untouched' }, 'none');
    }
    if (event.climate.systemMode === event.mode) {
      if (event.mode === 'off') {
        return settled({
          status: 'already',
          notifyCheck: false,
          stoppedAt: event.targetF,
          wanted: event.targetF,
          modeNote: { kind: 'already', mode: 'off' },
          step: 'none',
        });
      }
      return temperatureForMode(event.targetF, event.mode, event.climate, { kind: 'already', mode: event.mode });
    }
    return {
      phase: 'switch-mode',
      target: event.mode,
      followup: event.mode === 'off' ? { kind: 'none' } : { kind: 'set', targetF: event.targetF },
      targetF: event.targetF,
      climate: event.climate,
    };
  }

  if (event.type === 'mode-result') {
    if (state.phase !== 'switch-mode') {
      return state;
    }
    if (event.status === 'ambiguous' || event.status === 'failed' || event.status === 'cancelled' || event.status === 'refused' || event.status === 'busy') {
      return stopFromMode(event.status, state.targetF, event.reason);
    }
    if (event.reached !== state.target) {
      return stopFromMode('failed', state.targetF, 'The mode press finished on a different mode.');
    }
    const modeNote: ModeNote = event.status === 'already' ? { kind: 'already', mode: state.target } : { kind: 'switched', mode: state.target };
    return afterModeReached(state.target, state.followup, state.targetF, state.climate, modeNote);
  }

  if (state.phase !== 'set-temperature') {
    return state;
  }
  return settled({
    status: event.status,
    notifyCheck: event.status === 'ambiguous',
    reason: event.reason,
    stoppedAt: event.stoppedAt,
    wanted: event.wanted,
    modeNote: state.modeNote,
    step: 'temperature',
  });
}

export async function performScheduleApply(input: {
  mode: KnownMode | null;
  targetF: number;
  climate: ScheduleClimate;
  pressMode: (target: KnownMode) => Promise<ModePressReport>;
  pressTemperature: (targetF: number) => Promise<TemperaturePressReport>;
}): Promise<ScheduleApplyResult> {
  let state = reduceScheduleApply(idleScheduleApply(), {
    type: 'start',
    mode: input.mode,
    targetF: input.targetF,
    climate: input.climate,
  });
  if (state.phase === 'switch-mode') {
    const report = await input.pressMode(state.target);
    state = reduceScheduleApply(state, { type: 'mode-result', ...report });
  }
  if (state.phase === 'set-temperature') {
    const report = await input.pressTemperature(state.targetF);
    state = reduceScheduleApply(state, { type: 'temperature-result', ...report });
  }
  if (state.phase !== 'settled') {
    throw new Error('Schedule apply did not settle.');
  }
  return state.result;
}

export function alreadyCopy(label: string, targetF: number, result: ScheduleApplyResult): { record: string; log: string } {
  if (result.modeNote.kind === 'untouched') {
    return {
      record: `Already at ${targetF}°. No presses sent.`,
      log: `${label} was already at ${targetF}°. No presses sent.`,
    };
  }
  if (result.modeNote.mode === 'off') {
    const text = 'Already Off. No presses sent.';
    return { record: text, log: `${label}: ${text}` };
  }
  const text = `Already in ${modeLabel(result.modeNote.mode)} at ${targetF}°. No presses sent.`;
  return { record: text, log: `${label}: ${text}` };
}

export function doneCopy(label: string, targetF: number, result: ScheduleApplyResult): string {
  if (result.modeNote.kind === 'switched' && result.modeNote.mode === 'off') {
    return `${label} switched to Off. No temperature presses sent.`;
  }
  if (result.modeNote.kind === 'switched' && result.step === 'mode') {
    return `${label} switched to ${modeLabel(result.modeNote.mode)}. Already at ${targetF}°. No temperature presses sent.`;
  }
  if (result.modeNote.kind === 'switched') {
    return `${label} switched to ${modeLabel(result.modeNote.mode)} and set ${targetF}°.`;
  }
  return `${label} set to ${targetF}°.`;
}

export function ambiguousCopy(label: string, result: ScheduleApplyResult): string {
  if (result.step === 'mode') {
    return `Check the thermostat. ${label} may have changed mode, and that press was not counted. Later schedules still run.`;
  }
  return `Check the thermostat. ${label} may have moved, and the degree was not counted. Later schedules still run.`;
}
