import { createSqlDb, type SetpointDb } from './sqlDb';
import { readEnv } from './env';

type Query = <T>(sql: string, params?: unknown[]) => Promise<T[]>;

const RPC: Record<string, string> = {
  read_shared_state: 'read_shared_state',
  patch_shared_state: 'patch_shared_state',
  acquire_press_lease: 'acquire_press_lease',
  touch_press_lease: 'touch_press_lease',
  read_press_lease: 'read_press_lease',
  write_press_progress: 'write_press_progress',
  request_press_cancel: 'request_press_cancel',
  release_press_lease: 'release_press_lease',
  insert_meter_read: 'insert_meter_read',
  import_meter_reads: 'import_meter_reads',
  insert_setpoint_change: 'insert_setpoint_change',
  list_meter_reads: 'list_meter_reads',
  list_setpoint_changes: 'list_setpoint_changes',
  list_setpoint_changes_page: 'list_setpoint_changes_page',
  meter_read_bounds: 'meter_read_bounds',
  prune_meter_reads: 'prune_meter_reads',
  save_switchbot_credentials: 'save_switchbot_credentials',
  service_switchbot_credentials: 'service_switchbot_credentials',
};

export function createRestDb(options?: { url?: string; serviceRoleKey?: string; fetchImpl?: typeof fetch }): SetpointDb {
  const url = (options?.url ?? readEnv('SUPABASE_URL') ?? '').replace(/\/$/, '');
  const key = options?.serviceRoleKey ?? readEnv('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const fetchImpl = options?.fetchImpl ?? fetch;
  const query: Query = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => {
    const call = sqlToRpc(sql, params);
    if (!url || !key) {
      throw new Error('Supabase URL or service role key is missing.');
    }
    const response = await fetchImpl(`${url}/rest/v1/rpc/${call.name}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: key,
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(call.args),
    });
    if (!response.ok) {
      throw new Error(`Database call ${call.name} failed (${response.status}).`);
    }
    const text = await response.text();
    const value = text ? JSON.parse(text) : null;
    return [{ [call.column]: value } as T];
  };
  return createSqlDb(query);
}

function sqlToRpc(sql: string, params: unknown[]): { name: string; column: string; args: Record<string, unknown> } {
  const match = sql.match(/public\.([a-z_]+)/);
  const name = match?.[1];
  if (!name || !RPC[name]) {
    throw new Error('Unknown database call.');
  }
  const column = name;
  const args = argsFor(name, params);
  return { name, column, args };
}

function argsFor(name: string, params: unknown[]): Record<string, unknown> {
  if (name === 'patch_shared_state') {
    return { p_version: params[0], p_patch: typeof params[1] === 'string' ? JSON.parse(params[1]) : params[1] };
  }
  if (name === 'acquire_press_lease' || name === 'touch_press_lease') {
    return { p_owner: params[0], p_ttl_seconds: params[1] };
  }
  if (name === 'write_press_progress') {
    return { p_owner: params[0], p_progress: typeof params[1] === 'string' ? JSON.parse(params[1]) : params[1] };
  }
  if (name === 'release_press_lease') {
    return { p_owner: params[0] };
  }
  if (name === 'insert_meter_read') {
    return { p_at: params[0], p_temp: params[1], p_humidity: params[2], p_co2: params[3] };
  }
  if (name === 'import_meter_reads') {
    return { p_rows: typeof params[0] === 'string' ? JSON.parse(params[0]) : params[0] };
  }
  if (name === 'insert_setpoint_change') {
    return { p_at: params[0], p_setpoint: params[1], p_source: params[2], p_label: params[3] };
  }
  if (name === 'list_meter_reads') {
    return { p_since: params[0], p_until: params[1] ?? null, p_bucket_seconds: params[2] ?? 0 };
  }
  if (name === 'list_setpoint_changes') {
    return { p_since: params[0], p_until: params[1] ?? null };
  }
  if (name === 'list_setpoint_changes_page') {
    return { p_before_at: params[0] ?? null, p_before_id: params[1] ?? null, p_limit: params[2] };
  }
  if (name === 'save_switchbot_credentials') {
    return { p_token: params[0], p_secret: params[1] };
  }
  return {};
}
