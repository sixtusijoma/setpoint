import { modeOf, reduceTrackedMode, trackedFrom, type KnownMode, type ModeStep, type SystemMode } from './systemMode';

export type ModeSetpoints = {
  heat: number | null;
  cool: number | null;
};

export type ActiveSetpoint =
  | { status: 'active'; mode: 'heat' | 'cool'; degrees: number }
  | { status: 'unset'; mode: 'heat' | 'cool' }
  | { status: 'off' }
  | { status: 'unknown' };

export const OFF_SETPOINT_REASON =
  'The thermostat is Off, so there is no setpoint to change. Set Heat or Cool first.';

export const UNKNOWN_SETPOINT_REASON =
  'The thermostat mode is unknown. Tell Setpoint which mode it is in before changing the temperature.';

export const UNKNOWN_MODE_REASON =
  'Mode is unknown, so Setpoint will not press the Mode bot. Say which mode the thermostat is in right now.';

export function unsetReason(mode: 'heat' | 'cool'): string {
  return mode === 'heat' ? 'Set the Heat setpoint first.' : 'Set the Cool setpoint first.';
}

export function resolveActive(mode: SystemMode, points: ModeSetpoints): ActiveSetpoint {
  if (mode === 'unknown') {
    return { status: 'unknown' };
  }
  if (mode === 'off') {
    return { status: 'off' };
  }
  const degrees = points[mode];
  if (degrees === null) {
    return { status: 'unset', mode };
  }
  return { status: 'active', mode, degrees };
}

export function activeDegrees(mode: SystemMode, points: ModeSetpoints): number | null {
  const active = resolveActive(mode, points);
  return active.status === 'active' ? active.degrees : null;
}

export function refusalFor(active: ActiveSetpoint): string | null {
  if (active.status === 'active') {
    return null;
  }
  if (active.status === 'off') {
    return OFF_SETPOINT_REASON;
  }
  if (active.status === 'unknown') {
    return UNKNOWN_SETPOINT_REASON;
  }
  return unsetReason(active.mode);
}

export function migrateSingleSetpoint(single: number | null): ModeSetpoints {
  return { heat: single, cool: single };
}

export function climateOf(state: {
  systemMode: SystemMode;
  heatSetpoint: number | null;
  coolSetpoint: number | null;
}): ClimateControl {
  return { systemMode: state.systemMode, setpoints: { heat: state.heatSetpoint, cool: state.coolSetpoint } };
}

export type ClimateControl = {
  systemMode: SystemMode;
  setpoints: ModeSetpoints;
};

export type ClimateEvent =
  | { type: 'recalibrate-mode'; mode: KnownMode }
  | { type: 'commit-press'; step: ModeStep }
  | { type: 'set-active'; kind: 'adjust' | 'recalibrate'; degrees: number }
  | { type: 'seed'; degrees: number };

export function reduceClimate(
  state: ClimateControl,
  event: ClimateEvent,
): { state: ClimateControl; reason: string | null } {
  if (event.type === 'recalibrate-mode') {
    const tracked = reduceTrackedMode(trackedFrom(state.systemMode), { type: 'recalibrate', mode: event.mode });
    return { state: { ...state, systemMode: modeOf(tracked) }, reason: null };
  }
  if (event.type === 'commit-press') {
    if (state.systemMode === 'unknown') {
      return { state, reason: UNKNOWN_MODE_REASON };
    }
    const tracked = reduceTrackedMode(trackedFrom(state.systemMode), { type: 'advance', step: event.step });
    return { state: { ...state, systemMode: modeOf(tracked) }, reason: null };
  }
  if (event.type === 'seed') {
    if (!Number.isInteger(event.degrees)) {
      return { state, reason: 'Temperatures are whole degrees.' };
    }
    return { state: { ...state, setpoints: migrateSingleSetpoint(event.degrees) }, reason: null };
  }
  const active = resolveActive(state.systemMode, state.setpoints);
  if (active.status === 'off' || active.status === 'unknown') {
    return { state, reason: refusalFor(active) };
  }
  if (event.kind === 'adjust' && active.status === 'unset') {
    return { state, reason: unsetReason(active.mode) };
  }
  if (!Number.isInteger(event.degrees)) {
    return { state, reason: 'Temperatures are whole degrees.' };
  }
  return {
    state: { ...state, setpoints: { ...state.setpoints, [active.mode]: event.degrees } },
    reason: null,
  };
}
