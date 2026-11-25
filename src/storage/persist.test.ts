import AsyncStorage from '@react-native-async-storage/async-storage';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createDefaultState } from '@/state/model';
import { loadPersisted, savePersisted } from '@/storage/persist';

const memory = new Map<string, string>();

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => memory.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      memory.set(key, value);
    },
  },
}));

describe('persisted schedule mode', () => {
  beforeEach(() => {
    memory.clear();
  });

  it('keeps heat, cool, and off, and drops any other mode', async () => {
    const now = '2026-11-25T12:00:00.000Z';
    const state = createDefaultState(now);
    state.systemMode = 'heat';
    state.heatSetpoint = 68;
    state.coolSetpoint = 74;
    state.virtualSetpoint = 68;
    state.events = [
      { id: 'heat', label: 'Heat', hour: 7, minute: 0, targetF: 68, days: [1], enabled: true, mode: 'heat' },
      { id: 'cool', label: 'Cool', hour: 8, minute: 0, targetF: 74, days: [1], enabled: true, mode: 'cool' },
      { id: 'off', label: 'Off', hour: 9, minute: 0, targetF: 70, days: [1], enabled: true, mode: 'off' },
      { id: 'plain', label: 'Plain', hour: 10, minute: 0, targetF: 70, days: [1], enabled: true },
      { id: 'bad', label: 'Bad', hour: 11, minute: 0, targetF: 70, days: [1], enabled: true, mode: 'fan' as 'heat' },
    ];
    await savePersisted(state);
    const loaded = await loadPersisted(now);
    expect(loaded?.events.map((event) => event.mode ?? null)).toEqual(['heat', 'cool', 'off', null, null]);
    expect(loaded?.systemMode).toBe('heat');
    expect(loaded?.heatSetpoint).toBe(68);
    expect(AsyncStorage).toBeTruthy();
  });

  it('returns null for an empty store, bad JSON, and an old version', async () => {
    expect(await loadPersisted('2026-11-25T12:00:00.000Z')).toBeNull();
    memory.set('setpoint.state.v1', '{');
    expect(await loadPersisted('2026-11-25T12:00:00.000Z')).toBeNull();
    memory.set('setpoint.state.v1', JSON.stringify({ version: 0 }));
    expect(await loadPersisted('2026-11-25T12:00:00.000Z')).toBeNull();
  });
});
