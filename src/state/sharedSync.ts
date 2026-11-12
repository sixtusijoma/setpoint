import type { SharedSnapshot } from '@/server/appClient';
import type { Persisted } from '@/state/model';

// Fields the phone writes through PUT /state. The setpoint is not one of them:
// presses and recalibrate change it on the server, and the phone only reads it.
export const PUSHED_KEYS = [
  'catchupFrom',
  'hold',
  'settings',
  'deviceMap',
  'presets',
  'events',
  'records',
  'schedulePhase',
  'catchupNote',
  'roomLabel',
] as const;

export type PushedKey = (typeof PUSHED_KEYS)[number];

export const MAX_PUSH_CONFLICTS = 3;

export type SharedSync = {
  version: number;
  dirty: Set<PushedKey>;
  sending: Set<PushedKey>;
  recalibrating: boolean;
  conflicts: number;
};

export function createSharedSync(): SharedSync {
  return { version: 0, dirty: new Set(), sending: new Set(), recalibrating: false, conflicts: 0 };
}

export function snapshotFrom(state: Persisted, version: number): SharedSnapshot {
  return {
    version,
    virtualSetpoint: state.virtualSetpoint,
    catchupFrom: state.catchupFrom,
    mode: 'live',
    hold: state.hold,
    settings: state.settings,
    deviceMap: state.deviceMap,
    presets: state.presets,
    events: state.events,
    records: state.records,
    schedulePhase: state.schedulePhase,
    catchupNote: state.catchupNote,
    roomLabel: state.roomLabel,
  };
}

export function applySnapshot(prev: Persisted, snap: SharedSnapshot): Persisted {
  return {
    ...prev,
    virtualSetpoint: snap.virtualSetpoint,
    catchupFrom: snap.catchupFrom,
    hold: snap.hold,
    settings: { ...prev.settings, ...snap.settings },
    deviceMap: snap.deviceMap,
    presets: snap.presets,
    events: snap.events,
    records: snap.records,
    schedulePhase: snap.schedulePhase,
    catchupNote: snap.catchupNote,
    roomLabel: snap.roomLabel || prev.roomLabel,
    mode: 'live',
  };
}

export function noteLocalChange(sync: SharedSync, prev: Persisted, next: Persisted): void {
  for (const key of PUSHED_KEYS) {
    if (prev[key] !== next[key]) {
      sync.dirty.add(key);
    }
  }
}

export function acceptVersion(sync: SharedSync, version: number): void {
  sync.version = Math.max(sync.version, version);
}

export function resetSync(sync: SharedSync): void {
  sync.version = 0;
  sync.dirty.clear();
  sync.sending.clear();
  sync.conflicts = 0;
}

export function canPull(sync: SharedSync): boolean {
  return !sync.recalibrating;
}

export function takePatch(sync: SharedSync, state: Persisted): (Partial<SharedSnapshot> & { version: number }) | null {
  if (sync.dirty.size === 0) {
    return null;
  }
  const patch: Partial<SharedSnapshot> & { version: number } = { version: sync.version };
  const fields = patch as Record<string, unknown>;
  for (const key of sync.dirty) {
    fields[key] = state[key];
    sync.sending.add(key);
  }
  sync.dirty.clear();
  return patch;
}

export function settlePush(sync: SharedSync, outcome: { ok: true; saved: SharedSnapshot } | { ok: false; conflict: boolean }): void {
  if (outcome.ok) {
    acceptVersion(sync, outcome.saved.version);
    sync.conflicts = 0;
  } else {
    for (const key of sync.sending) {
      sync.dirty.add(key);
    }
    if (outcome.conflict) {
      sync.conflicts += 1;
    }
  }
  sync.sending.clear();
}

// A pull that started before a newer write finished carries an older version.
// Drop it, and keep any field the phone changed but the server has not taken yet.
export function mergePulled(sync: SharedSync, local: Persisted, snap: SharedSnapshot): Persisted | null {
  if (snap.version < sync.version) {
    return null;
  }
  acceptVersion(sync, snap.version);
  const merged = applySnapshot(local, snap);
  const kept = merged as Record<string, unknown>;
  for (const key of [...sync.dirty, ...sync.sending]) {
    kept[key] = local[key];
  }
  return merged;
}
