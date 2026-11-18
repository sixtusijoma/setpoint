export const MODE_CYCLE = ['heat', 'off', 'cool'] as const;

export type KnownMode = (typeof MODE_CYCLE)[number];
export type SystemMode = KnownMode | 'unknown';
export type ModeStep = 1 | 2;

export type TrackedMode = { status: 'unknown' } | { status: 'known'; mode: KnownMode };

export type TrackedModeEvent =
  | { type: 'recalibrate'; mode: KnownMode }
  | { type: 'advance'; step: ModeStep };

export function isKnownMode(value: unknown): value is KnownMode {
  return value === 'heat' || value === 'off' || value === 'cool';
}

export function isSystemMode(value: unknown): value is SystemMode {
  return value === 'unknown' || isKnownMode(value);
}

export function modeStepOf(value: unknown): ModeStep {
  return value === 1 ? 1 : 2;
}

export function modeLabel(mode: KnownMode): string {
  if (mode === 'heat') {
    return 'Heat';
  }
  if (mode === 'off') {
    return 'Off';
  }
  return 'Cool';
}

export function trackedFrom(mode: SystemMode): TrackedMode {
  if (mode === 'unknown') {
    return { status: 'unknown' };
  }
  return { status: 'known', mode };
}

export function modeOf(tracked: TrackedMode): SystemMode {
  return tracked.status === 'known' ? tracked.mode : 'unknown';
}

export function advanceMode(mode: KnownMode, step: ModeStep): KnownMode {
  const index = MODE_CYCLE.indexOf(mode);
  return MODE_CYCLE[(index + step) % MODE_CYCLE.length];
}

export function pressesToMode(from: KnownMode, to: KnownMode, step: ModeStep): number {
  let mode: KnownMode = from;
  for (let count = 0; count < MODE_CYCLE.length; count += 1) {
    if (mode === to) {
      return count;
    }
    mode = advanceMode(mode, step);
  }
  return MODE_CYCLE.length;
}

export function reduceTrackedMode(state: TrackedMode, event: TrackedModeEvent): TrackedMode {
  if (event.type === 'recalibrate') {
    if (!isKnownMode(event.mode)) {
      return state;
    }
    return { status: 'known', mode: event.mode };
  }
  if (state.status !== 'known') {
    return state;
  }
  if (event.step !== 1 && event.step !== 2) {
    return state;
  }
  return { status: 'known', mode: advanceMode(state.mode, event.step) };
}
