import { describe, expect, it } from 'vitest';

import {
  openDraft,
  pickMode,
  planRecalibrate,
  PICK_MODE_REASON,
  recalibrateChangeLabel,
  setDraftDegrees,
  type RecalibrateContext,
} from './recalibrateDraft';

const base: RecalibrateContext = { systemMode: 'heat', heatSetpoint: 70, coolSetpoint: 76, fallbackDegrees: 72 };

describe('combined Recalibrate sheet', () => {
  it('starts on the tracked mode and both stored setpoints', () => {
    expect(openDraft(base)).toEqual({ mode: 'heat', heat: 70, cool: 76 });
    expect(openDraft({ ...base, systemMode: 'cool' })).toEqual({ mode: 'cool', heat: 70, cool: 76 });
    expect(openDraft({ ...base, systemMode: 'off', heatSetpoint: null })).toEqual({ mode: 'off', heat: 72, cool: 76 });
  });

  it('starts with no mode picked when the mode is unknown and refuses to save until one is', () => {
    const context = { ...base, systemMode: 'unknown' as const };
    const draft = openDraft(context);
    expect(draft.mode).toBeNull();
    expect(planRecalibrate({ ...draft, heat: 68, cool: 74 }, context)).toEqual({ ok: false, reason: PICK_MODE_REASON });
  });

  it('lets a known current mode count so the other setpoint can change without picking a mode', () => {
    expect(planRecalibrate({ mode: null, heat: 70, cool: 74 }, base)).toEqual({
      ok: true,
      setMode: null,
      setHeat: null,
      setCool: 74,
    });
  });

  it('keeps Heat and Cool edits when a mode is picked', () => {
    const edited = setDraftDegrees(setDraftDegrees(openDraft(base), 'heat', 68), 'cool', 74);
    expect(pickMode(edited, 'cool')).toEqual({ mode: 'cool', heat: 68, cool: 74 });
    expect(pickMode(edited, 'heat')).toBe(edited);
  });

  it('saves only the setpoint that changed when the mode is right', () => {
    expect(planRecalibrate({ mode: 'heat', heat: 68, cool: 76 }, base)).toEqual({
      ok: true,
      setMode: null,
      setHeat: 68,
      setCool: null,
    });
  });

  it('saves only the mode when both setpoints already match', () => {
    expect(planRecalibrate({ mode: 'cool', heat: 70, cool: 76 }, base)).toEqual({
      ok: true,
      setMode: 'cool',
      setHeat: null,
      setCool: null,
    });
  });

  it('saves the mode and both setpoints when all three differ', () => {
    expect(planRecalibrate({ mode: 'cool', heat: 68, cool: 74 }, base)).toEqual({
      ok: true,
      setMode: 'cool',
      setHeat: 68,
      setCool: 74,
    });
  });

  it('saves Off without dropping setpoint edits', () => {
    expect(planRecalibrate({ mode: 'off', heat: 68, cool: 76 }, base)).toEqual({
      ok: true,
      setMode: 'off',
      setHeat: 68,
      setCool: null,
    });
  });

  it('writes a missing setpoint when the sheet shows a number the record does not have', () => {
    expect(planRecalibrate({ mode: 'heat', heat: 72, cool: 76 }, { ...base, heatSetpoint: null })).toEqual({
      ok: true,
      setMode: null,
      setHeat: 72,
      setCool: null,
    });
  });

  it('does nothing when nothing changed', () => {
    expect(planRecalibrate(openDraft(base), base)).toEqual({ ok: true, setMode: null, setHeat: null, setCool: null });
  });

  it('names each setpoint change for the history list', () => {
    expect(recalibrateChangeLabel('heat', 68)).toBe('Recalibrated Heat · 68°');
    expect(recalibrateChangeLabel('cool', 74)).toBe('Recalibrated Cool · 74°');
  });
});
