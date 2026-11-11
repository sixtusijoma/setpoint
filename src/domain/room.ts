import type { ClimateState } from '@/devices/simulator';
import type { LiveReading, Mode } from '@/state/model';

export type RoomState =
  | { kind: 'demo'; climate: ClimateState }
  | { kind: 'live'; phase: 'unread' }
  | { kind: 'live'; phase: 'loading'; previous: LiveReading | null }
  | { kind: 'live'; phase: 'fresh'; reading: LiveReading }
  | { kind: 'live'; phase: 'stale'; reading: LiveReading; error: string };

export function deriveRoom(input: {
  mode: Mode;
  climate: ClimateState;
  lastLive: LiveReading | null;
  refreshing: boolean;
  error: string | null;
}): RoomState {
  if (input.mode === 'demo') {
    return { kind: 'demo', climate: input.climate };
  }
  if (input.refreshing) {
    return { kind: 'live', phase: 'loading', previous: input.lastLive };
  }
  if (input.lastLive && input.error) {
    return { kind: 'live', phase: 'stale', reading: input.lastLive, error: input.error };
  }
  if (input.lastLive) {
    return { kind: 'live', phase: 'fresh', reading: input.lastLive };
  }
  return { kind: 'live', phase: 'unread' };
}

export function readingFromRoom(room: RoomState): {
  temperatureF: number;
  humidity: number;
  co2Ppm: number;
  updatedAt: string;
  batteryUp: number | null;
  batteryDown: number | null;
  batteryMeter: number | null;
} | null {
  if (room.kind === 'demo') {
    return room.climate;
  }
  if (room.phase === 'fresh' || room.phase === 'stale') {
    return room.reading;
  }
  if (room.phase === 'loading') {
    return room.previous;
  }
  return null;
}
