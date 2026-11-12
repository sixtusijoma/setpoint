import { describe, expect, it } from 'vitest';

import type { SharedSnapshot } from '@/server/appClient';
import { createDefaultState, type Persisted } from './model';
import {
  acceptVersion,
  canPull,
  createSharedSync,
  mergePulled,
  noteLocalChange,
  settlePush,
  snapshotFrom,
  takePatch,
} from './sharedSync';

function live(setpoint: number): Persisted {
  return { ...createDefaultState('2026-11-12T14:00:00.000Z'), mode: 'live', virtualSetpoint: setpoint };
}

function server(state: Persisted, version: number, patch: Partial<SharedSnapshot> = {}): SharedSnapshot {
  return { ...snapshotFrom(state, version), ...patch };
}

describe('shared sync', () => {
  it('keeps a recalibrated setpoint when a reload races it', () => {
    const sync = createSharedSync();
    let local = live(70);
    acceptVersion(sync, 10);

    // A reload leaves before Save and still carries the old setpoint.
    const stale = server(local, 10);

    sync.recalibrating = true;
    expect(canPull(sync)).toBe(false);

    // The server takes the recalibrate at version 11.
    acceptVersion(sync, 11);
    local = { ...local, virtualSetpoint: 66 };
    sync.recalibrating = false;

    expect(mergePulled(sync, local, stale)).toBeNull();
    expect(local.virtualSetpoint).toBe(66);

    const fresh = mergePulled(sync, local, server(local, 12, { virtualSetpoint: 66 }));
    expect(fresh?.virtualSetpoint).toBe(66);
    expect(sync.version).toBe(12);
  });

  it('never pushes the setpoint and sends only the fields that changed', () => {
    const sync = createSharedSync();
    acceptVersion(sync, 4);
    const prev = live(70);
    const next = { ...prev, roomLabel: 'Office', virtualSetpoint: 60 };
    noteLocalChange(sync, prev, next);
    const patch = takePatch(sync, next);
    expect(patch).toEqual({ version: 4, roomLabel: 'Office' });
    expect(takePatch(sync, next)).toBeNull();
  });

  it('keeps unsent fields through a reload and resends them after a conflict', () => {
    const sync = createSharedSync();
    acceptVersion(sync, 4);
    const prev = live(70);
    const local = { ...prev, roomLabel: 'Office' };
    noteLocalChange(sync, prev, local);
    takePatch(sync, local);

    // The tick bumped the row, so the save comes back 409.
    settlePush(sync, { ok: false, conflict: true });
    expect([...sync.dirty]).toEqual(['roomLabel']);
    expect(sync.conflicts).toBe(1);

    const pulled = mergePulled(sync, local, server(prev, 5, { roomLabel: 'Home', virtualSetpoint: 71 }));
    expect(pulled?.roomLabel).toBe('Office');
    expect(pulled?.virtualSetpoint).toBe(71);

    const retry = takePatch(sync, pulled as Persisted);
    expect(retry).toEqual({ version: 5, roomLabel: 'Office' });
    settlePush(sync, { ok: true, saved: server(pulled as Persisted, 6) });
    expect(sync.conflicts).toBe(0);
    expect(sync.sending.size).toBe(0);
    const after = mergePulled(sync, pulled as Persisted, server(prev, 7, { roomLabel: 'Den' }));
    expect(after?.roomLabel).toBe('Den');
  });

  it('keeps a field that is still in flight when a reload lands', () => {
    const sync = createSharedSync();
    const prev = live(70);
    const local = { ...prev, roomLabel: 'Office' };
    noteLocalChange(sync, prev, local);
    takePatch(sync, local);
    const pulled = mergePulled(sync, local, server(prev, 1, { roomLabel: 'Home' }));
    expect(pulled?.roomLabel).toBe('Office');
  });
});
