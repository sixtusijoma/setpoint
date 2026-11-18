import { modeLabel, type KnownMode, type SystemMode } from './systemMode';

/**
 * One Recalibrate sheet handles both things the display can disagree with:
 * the mode (Heat, Off, Cool) and the active setpoint. Nothing is pressed.
 */
export type RecalibrateDraft = {
  /** null until a mode is picked. Starts null when the tracked mode is unknown. */
  mode: KnownMode | null;
  /** Degrees on the display. Ignored when the picked mode is Off. */
  degrees: number;
};

export type RecalibrateContext = {
  systemMode: SystemMode;
  heatSetpoint: number | null;
  coolSetpoint: number | null;
  fallbackDegrees: number;
};

export type RecalibratePlan =
  | { ok: true; setMode: KnownMode | null; setDegrees: number | null }
  | { ok: false; reason: string };

export const PICK_MODE_REASON = 'Pick the mode the thermostat display shows: Heat, Off, or Cool.';

export function storedDegrees(mode: KnownMode | null, context: RecalibrateContext): number {
  if (mode === 'heat') {
    return context.heatSetpoint ?? context.fallbackDegrees;
  }
  if (mode === 'cool') {
    return context.coolSetpoint ?? context.fallbackDegrees;
  }
  return context.fallbackDegrees;
}

export function openDraft(context: RecalibrateContext): RecalibrateDraft {
  const mode = context.systemMode === 'unknown' ? null : context.systemMode;
  return { mode, degrees: storedDegrees(mode, context) };
}

/** Picking a mode loads that mode's saved setpoint so the stepper starts somewhere sensible. */
export function pickMode(draft: RecalibrateDraft, mode: KnownMode, context: RecalibrateContext): RecalibrateDraft {
  if (draft.mode === mode) {
    return draft;
  }
  return { mode, degrees: storedDegrees(mode, context) };
}

/** What Save has to do, in order: record the mode first, then the setpoint for that mode. */
export function planRecalibrate(draft: RecalibrateDraft, context: RecalibrateContext): RecalibratePlan {
  if (draft.mode === null) {
    return { ok: false, reason: PICK_MODE_REASON };
  }
  const setMode = draft.mode === context.systemMode ? null : draft.mode;
  if (draft.mode === 'off') {
    return { ok: true, setMode, setDegrees: null };
  }
  const saved = draft.mode === 'heat' ? context.heatSetpoint : context.coolSetpoint;
  const setDegrees = saved === draft.degrees ? null : draft.degrees;
  return { ok: true, setMode, setDegrees };
}

export function alreadyInMode(mode: KnownMode): string {
  return `Setpoint already has the thermostat on ${modeLabel(mode)}, so nothing was pressed. If the display shows something else, tap Recalibrate.`;
}

export function unknownModeNote(wanted: KnownMode): string {
  return `Setpoint does not know the mode yet. Pick the mode the display shows now and save, then tap ${modeLabel(wanted)} again.`;
}
