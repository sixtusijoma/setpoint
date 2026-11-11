import type { HistorySample, SetpointChange } from '../domain/history';
import type { CommandSource } from '../domain/pressSession';
import type { HoldState, RunRecord, ScheduleEvent } from '../domain/schedule';
import type { SchedulePhase } from '../domain/scheduleRunner';

export type { CommandSource, HistorySample, SetpointChange };

export type ServerSettings = {
  step: number;
  delayMs: number;
  minF: number;
  maxF: number;
  pressCap: number;
  wakeFirst: boolean;
};

export type ServerDevice = {
  id: string;
  name: string;
  deviceType: string;
  enableCloudService: boolean | null;
  hubDeviceId: string;
};

export type ServerDeviceMap = {
  up: ServerDevice | null;
  down: ServerDevice | null;
  meter: ServerDevice | null;
};

export type ServerPreset = {
  id: string;
  label: string;
  tempF: number;
};

export type SharedSnapshot = {
  version: number;
  virtualSetpoint: number | null;
  catchupFrom: string | null;
  mode: 'demo' | 'live';
  hold: HoldState;
  settings: ServerSettings;
  deviceMap: ServerDeviceMap;
  presets: ServerPreset[];
  events: ScheduleEvent[];
  records: RunRecord[];
  schedulePhase: SchedulePhase;
  catchupNote: string | null;
  roomLabel: string;
};

export type LeaseView = {
  phase: 'idle' | 'running';
  owner: string | null;
  cancelRequested: boolean;
  leaseUntil: string | null;
  progress: { index: number; total: number; target: number; label: 'press' | 'finishing' } | null;
};

export type CommandResult = {
  status: 'done' | 'already' | 'cancelled' | 'failed' | 'refused' | 'busy' | 'ambiguous';
  stoppedAt: number;
  wanted: number;
  reason?: string;
  notifyCheck: boolean;
};
