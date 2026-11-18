import type { BatteryReading } from '../domain/batteryFetch';
import type { HistorySample, SetpointChange } from '../domain/history';
import type { CommandSource } from '../domain/pressSession';
import type { HoldState, RunRecord, ScheduleEvent } from '../domain/schedule';
import type { SchedulePhase } from '../domain/scheduleRunner';
import type { ModeStep, SystemMode } from '../domain/systemMode';

export type { CommandSource, HistorySample, SetpointChange };

export type ServerSettings = {
  step: number;
  delayMs: number;
  minF: number;
  maxF: number;
  pressCap: number;
  wakeFirst: boolean;
  modeStep: ModeStep;
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
  mode: ServerDevice | null;
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
  systemMode: SystemMode;
  heatSetpoint: number | null;
  coolSetpoint: number | null;
  batteryCache: BatteryReading | null;
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
  progress: {
    index: number;
    total: number;
    target: number;
    label: 'press' | 'finishing';
    kind?: 'setpoint' | 'mode';
    systemMode?: SystemMode;
  } | null;
};

export type CommandResult = {
  status: 'done' | 'already' | 'cancelled' | 'failed' | 'refused' | 'busy' | 'ambiguous';
  stoppedAt: number;
  wanted: number;
  reason?: string;
  notifyCheck: boolean;
};
