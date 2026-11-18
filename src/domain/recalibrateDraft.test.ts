import { describe, expect, it } from 'vitest';

import { openDraft, pickMode, planRecalibrate, PICK_MODE_REASON, type RecalibrateContext } from './recalibrateDraft';

const base: RecalibrateContext = { systemMode: 'heat', heatSetpoint: 70, coolSetpoint: 76, fallbackDegrees: 72 };

describe('combined Recalibrate sheet', () => {
  it('starts on the tracked mode and its setpoint', () => {
    expect(openDraft(base)).toEqual({ mode: 'heat', degrees: 70 });
    expect(openDraft({ ...base, systemMode: 'cool' })).toEqual({ mode: 'cool', degrees: 76 });
  });

  it('starts with no mode picked when the mode is unknown and refuses to save until one is', () => {
    const draft = openDraft({ ...base, systemMode: 'unknown' });
    expect(draft.mode).toBeNull();
    expect(planRecalibrate(draft, { ...base, systemMode: 'unknown' })).toEqual({ ok: false, reason: PICK_MODE_REASON });
  });

  it('loads the picked mode setpoint', () => {
    expect(pickMode(openDraft(base), 'cool', base)).toEqual({ mode: 'cool', degrees: 76 });
  });

  it('saves only the setpoint when the mode is right', () => {
    expect(planRecalibrate({ mode: 'heat', degrees: 68 }, base)).toEqual({ ok: true, setMode: null, setDegrees: 68 });
  });

  it('saves only the mode when the setpoint already matches', () => {
    expect(planRecalibrate({ mode: 'cool', degrees: 76 }, base)).toEqual({ ok: true, setMode: 'cool', setDegrees: null });
  });

  it('saves mode then setpoint when both differ', () => {
    expect(planRecalibrate({ mode: 'cool', degrees: 74 }, base)).toEqual({ ok: true, setMode: 'cool', setDegrees: 74 });
  });

  it('never saves a setpoint for Off', () => {
    expect(planRecalibrate({ mode: 'off', degrees: 60 }, base)).toEqual({ ok: true, setMode: 'off', setDegrees: null });
  });

  it('does nothing when nothing changed', () => {
    expect(planRecalibrate({ mode: 'heat', degrees: 70 }, base)).toEqual({ ok: true, setMode: null, setDegrees: null });
  });
});
