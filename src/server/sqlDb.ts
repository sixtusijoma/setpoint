import type { HistorySample, SetpointChange } from '../domain/history';
import type { LeaseView, SharedSnapshot } from './types';

type Query = <T>(sql: string, params?: unknown[]) => Promise<T[]>;

function asJson<T>(value: unknown): T {
  if (typeof value === 'string') {
    return JSON.parse(value) as T;
  }
  return value as T;
}

export type SetpointDb = {
  readState: () => Promise<SharedSnapshot>;
  patchState: (version: number | null, patch: Record<string, unknown>) => Promise<SharedSnapshot | null>;
  acquireLease: (owner: string, ttlSeconds: number) => Promise<boolean>;
  touchLease: (owner: string, ttlSeconds: number) => Promise<void>;
  readLease: () => Promise<LeaseView>;
  writeProgress: (owner: string, progress: LeaseView['progress']) => Promise<void>;
  requestCancel: () => Promise<void>;
  releaseLease: (owner: string) => Promise<void>;
  insertRead: (sample: HistorySample) => Promise<void>;
  insertChange: (change: SetpointChange) => Promise<void>;
  listReads: (sinceIso: string) => Promise<HistorySample[]>;
  listChanges: (sinceIso: string) => Promise<SetpointChange[]>;
  pruneReads: () => Promise<{ rolled: number; deleted: number }>;
  saveCredentials: (token: string, secret: string) => Promise<void>;
  readCredentials: () => Promise<{ token: string; secret: string } | null>;
};

export function createSqlDb(query: Query): SetpointDb {
  return {
    async readState() {
      const rows = await query<{ read_shared_state: unknown }>('select public.read_shared_state() as read_shared_state');
      return asJson<SharedSnapshot>(rows[0]?.read_shared_state);
    },
    async patchState(version, patch) {
      const rows = await query<{ patch_shared_state: unknown }>(
        'select public.patch_shared_state($1::int, $2::jsonb) as patch_shared_state',
        [version, JSON.stringify(patch)],
      );
      const value = rows[0]?.patch_shared_state;
      if (value === null || value === undefined) {
        return null;
      }
      return asJson<SharedSnapshot>(value);
    },
    async acquireLease(owner, ttlSeconds) {
      const rows = await query<{ acquire_press_lease: boolean }>(
        'select public.acquire_press_lease($1::text, $2::int) as acquire_press_lease',
        [owner, ttlSeconds],
      );
      return Boolean(rows[0]?.acquire_press_lease);
    },
    async touchLease(owner, ttlSeconds) {
      await query('select public.touch_press_lease($1::text, $2::int)', [owner, ttlSeconds]);
    },
    async readLease() {
      const rows = await query<{ read_press_lease: unknown }>('select public.read_press_lease() as read_press_lease');
      return asJson<LeaseView>(rows[0]?.read_press_lease);
    },
    async writeProgress(owner, progress) {
      await query('select public.write_press_progress($1::text, $2::jsonb)', [owner, JSON.stringify(progress)]);
    },
    async requestCancel() {
      await query('select public.request_press_cancel()');
    },
    async releaseLease(owner) {
      await query('select public.release_press_lease($1::text)', [owner]);
    },
    async insertRead(sample) {
      await query('select public.insert_meter_read($1::timestamptz, $2::float8, $3::float8, $4::int)', [
        sample.at,
        sample.temperatureF,
        sample.humidity,
        sample.co2Ppm,
      ]);
    },
    async insertChange(change) {
      await query('select public.insert_setpoint_change($1::timestamptz, $2::int, $3::text, $4::text)', [
        change.at,
        change.setpoint,
        change.source,
        change.label,
      ]);
    },
    async listReads(sinceIso) {
      const rows = await query<{ list_meter_reads: unknown }>('select public.list_meter_reads($1::timestamptz) as list_meter_reads', [
        sinceIso,
      ]);
      return asJson<HistorySample[]>(rows[0]?.list_meter_reads ?? []);
    },
    async listChanges(sinceIso) {
      const rows = await query<{ list_setpoint_changes: unknown }>(
        'select public.list_setpoint_changes($1::timestamptz) as list_setpoint_changes',
        [sinceIso],
      );
      return asJson<SetpointChange[]>(rows[0]?.list_setpoint_changes ?? []);
    },
    async pruneReads() {
      const rows = await query<{ prune_meter_reads: unknown }>('select public.prune_meter_reads() as prune_meter_reads');
      return asJson<{ rolled: number; deleted: number }>(rows[0]?.prune_meter_reads);
    },
    async saveCredentials(token, secret) {
      await query('select public.save_switchbot_credentials($1::text, $2::text)', [token, secret]);
    },
    async readCredentials() {
      const rows = await query<{ service_switchbot_credentials: unknown }>(
        'select public.service_switchbot_credentials() as service_switchbot_credentials',
      );
      const value = rows[0]?.service_switchbot_credentials;
      if (!value) {
        return null;
      }
      return asJson<{ token: string; secret: string }>(value);
    },
  };
}
