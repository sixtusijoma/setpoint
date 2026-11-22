import { modeLabel, type KnownMode, type SystemMode } from './systemMode';

/**
 * One Recalibrate sheet corrects the mode and both stored setpoints.
 * Save writes only the fields that differ from the record. Nothing is pressed.
 */
export type RecalibrateDraft = {
  /** null until a mode is picked. Starts as the known current mode, or null when unknown. */
  mode: KnownMode | null;
  heat: number;
  cool: number;
};

export type RecalibrateContext = {
  systemMode: SystemMode;
  heatSetpoint: number | null;
  coolSetpoint: number | null;
  fallbackDegrees: number;
};

export type RecalibratePlan =
  | { ok: true; setMode: KnownMode | null; setHeat: number | null; setCool: number | null }
  | { ok: false; reason: string };

export const PICK_MODE_REASON = 'Pick the mode the thermostat display shows: Heat, Off, or Cool.';

export function openDraft(context: RecalibrateContext): RecalibrateDraft {
  const mode = context.systemMode === 'unknown' ? null : context.systemMode;
  return {
    mode,
    heat: context.heatSetpoint ?? context.fallbackDegrees,
    cool: context.coolSetpoint ?? context.fallbackDegrees,
  };
}

/** Picking a mode records that mode. It does not replace the Heat or Cool numbers already on the sheet. */
export function pickMode(draft: RecalibrateDraft, mode: KnownMode): RecalibrateDraft {
  if (draft.mode === mode) {
    return draft;
  }
  return { ...draft, mode };
}

export function setDraftDegrees(draft: RecalibrateDraft, which: 'heat' | 'cool', degrees: number): RecalibrateDraft {
  if (which === 'heat') {
    return draft.heat === degrees ? draft : { ...draft, heat: degrees };
  }
  return draft.cool === degrees ? draft : { ...draft, cool: degrees };
}

/**
 * What Save has to write. A known current mode counts, so the other setpoint
 * can change without picking a mode. Unknown mode still has to be picked.
 * null means that field matches the record and must not be written.
 */
export function planRecalibrate(draft: RecalibrateDraft, context: RecalibrateContext): RecalibratePlan {
  const known = draft.mode ?? (context.systemMode === 'unknown' ? null : context.systemMode);
  if (known === null) {
    return { ok: false, reason: PICK_MODE_REASON };
  }
  const setMode = draft.mode !== null && draft.mode !== context.systemMode ? draft.mode : null;
  const setHeat = context.heatSetpoint === draft.heat ? null : draft.heat;
  const setCool = context.coolSetpoint === draft.cool ? null : draft.cool;
  return { ok: true, setMode, setHeat, setCool };
}

export function recalibrateChangeLabel(mode: 'heat' | 'cool', degrees: number): string {
  return mode === 'heat' ? `Recalibrated Heat · ${degrees}°` : `Recalibrated Cool · ${degrees}°`;
}

export function alreadyInMode(mode: KnownMode): string {
  return `Setpoint already has the thermostat on ${modeLabel(mode)}, so nothing was pressed. If the display shows something else, tap Recalibrate.`;
}

export function unknownModeNote(wanted: KnownMode): string {
  return `Setpoint does not know the mode yet. Pick the mode the display shows now and save, then tap ${modeLabel(wanted)} again.`;
}
