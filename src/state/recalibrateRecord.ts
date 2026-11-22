import { recalibrateChangeLabel } from '@/domain/recalibrateDraft';
import { climateOf, reduceClimate } from '@/domain/modeSetpoint';
import { isKnownMode, modeLabel, type KnownMode, type SystemMode } from '@/domain/systemMode';
import { appendLog, applyClimate, type Persisted } from '@/state/model';

/** null leaves that field as it is. Recalibrate records a number; it does not clear one. */
export type RecalibrateWrite = {
  mode: KnownMode | null;
  heat: number | null;
  cool: number | null;
};

export function recalibrateNote(write: RecalibrateWrite): string {
  const lines: string[] = [];
  if (write.mode) {
    lines.push(`The thermostat is ${modeLabel(write.mode)}.`);
  }
  if (write.heat !== null && write.cool !== null) {
    lines.push(`Recalibrated Heat to ${write.heat}° and Cool to ${write.cool}°.`);
  } else if (write.heat !== null) {
    lines.push(`Recalibrated the Heat setpoint to ${write.heat}°.`);
  } else if (write.cool !== null) {
    lines.push(`Recalibrated the Cool setpoint to ${write.cool}°.`);
  }
  lines.push('No buttons were pressed.');
  return lines.join(' ');
}

export function recordRecalibration(prev: Persisted, write: RecalibrateWrite, at: string): Persisted {
  if (write.mode === null && write.heat === null && write.cool === null) {
    return prev;
  }
  const climate = reduceClimate(climateOf(prev), {
    type: 'recalibrate-record',
    mode: write.mode,
    heat: write.heat,
    cool: write.cool,
  });
  if (climate.reason) {
    return prev;
  }
  const next = applyClimate(prev, climate.state);
  const changes = [...next.changes];
  if (write.heat !== null) {
    changes.push({ at, setpoint: write.heat, source: 'recalibrated', label: recalibrateChangeLabel('heat', write.heat) });
  }
  if (write.cool !== null) {
    changes.push({ at, setpoint: write.cool, source: 'recalibrated', label: recalibrateChangeLabel('cool', write.cool) });
  }
  return appendLog({ ...next, changes: changes.slice(-400) }, 'calibration', recalibrateNote(write), at);
}

/** Fields the server actually changed. A missing field is left alone, so an older response cannot clear a setpoint. */
export function appliedWrite(
  prev: { systemMode: SystemMode; heatSetpoint: number | null; coolSetpoint: number | null },
  saved: { systemMode?: string; heatSetpoint?: number | null; coolSetpoint?: number | null },
): RecalibrateWrite {
  return {
    mode: isKnownMode(saved.systemMode) && saved.systemMode !== prev.systemMode ? saved.systemMode : null,
    heat: typeof saved.heatSetpoint === 'number' && saved.heatSetpoint !== prev.heatSetpoint ? saved.heatSetpoint : null,
    cool: typeof saved.coolSetpoint === 'number' && saved.coolSetpoint !== prev.coolSetpoint ? saved.coolSetpoint : null,
  };
}
