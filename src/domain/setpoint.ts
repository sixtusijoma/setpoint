import type { PressSession } from '@/domain/pressSession';
import { isRunning } from '@/domain/pressSession';

export type SetpointAnchor =
  | { kind: 'unset' }
  | { kind: 'anchored'; degrees: number; source: 'calibrated' | 'press' | 'recalibrated' };

export function anchorFrom(
  value: number | null,
  source: 'calibrated' | 'press' | 'recalibrated',
): SetpointAnchor {
  if (value === null) {
    return { kind: 'unset' };
  }
  return { kind: 'anchored', degrees: value, source };
}

export function writeSetpoint(
  current: number | null,
  write: { degrees: number; source: 'calibrated' | 'press' | 'recalibrated' },
  session: PressSession,
): { ok: true; degrees: number } | { ok: false; reason: string } {
  if (isRunning(session) && write.source !== 'press') {
    return { ok: false, reason: 'Wait for the press to finish before changing the setpoint.' };
  }
  if (!Number.isInteger(write.degrees)) {
    return { ok: false, reason: 'Temperatures are whole degrees.' };
  }
  if (current === null && write.source === 'press') {
    return { ok: false, reason: 'Set the virtual setpoint first.' };
  }
  return { ok: true, degrees: write.degrees };
}
