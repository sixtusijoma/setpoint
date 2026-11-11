create schema if not exists private;
revoke all on schema private from public;

create table if not exists public.shared_state (
  id int primary key default 1 check (id = 1),
  version int not null default 1,
  virtual_setpoint int,
  catchup_from timestamptz,
  mode text not null default 'demo' check (mode in ('demo', 'live')),
  hold jsonb,
  settings jsonb not null,
  device_map jsonb not null,
  presets jsonb not null,
  events jsonb not null,
  records jsonb not null default '[]'::jsonb,
  schedule_phase text not null default 'armed' check (schedule_phase in ('armed', 'paused-after-failure')),
  catchup_note text,
  room_label text not null default 'Home',
  updated_at timestamptz not null default now()
);

insert into public.shared_state (
  id, settings, device_map, presets, events
) values (
  1,
  '{"step":1,"delayMs":1000,"minF":50,"maxF":85,"pressCap":15,"wakeFirst":false}'::jsonb,
  '{"up":null,"down":null,"meter":null}'::jsonb,
  '[{"id":"sleep","label":"Sleep","tempF":61},{"id":"wake","label":"Wake","tempF":70},{"id":"away","label":"Away","tempF":62},{"id":"home","label":"Home","tempF":72}]'::jsonb,
  '[{"id":"default-sleep","label":"Sleep","hour":23,"minute":45,"targetF":61,"days":[1,2,3,4,5],"enabled":true},{"id":"default-wake","label":"Wake","hour":6,"minute":45,"targetF":70,"days":[1,2,3,4,5,6,7],"enabled":true}]'::jsonb
) on conflict (id) do nothing;

create table if not exists public.press_lease (
  id int primary key default 1 check (id = 1),
  phase text not null default 'idle' check (phase in ('idle', 'running')),
  owner text,
  progress jsonb,
  cancel_requested boolean not null default false,
  lease_until timestamptz,
  updated_at timestamptz not null default now()
);

insert into public.press_lease (id) values (1) on conflict (id) do nothing;

create table if not exists public.meter_reads (
  id bigint generated always as identity primary key,
  read_at timestamptz not null,
  temperature_f double precision not null,
  humidity double precision not null,
  co2_ppm integer not null,
  granularity text not null default 'raw' check (granularity in ('raw', 'hour')),
  unique (read_at, granularity)
);

create index if not exists meter_reads_read_at_idx on public.meter_reads (read_at desc);

create table if not exists public.setpoint_changes (
  id bigint generated always as identity primary key,
  changed_at timestamptz not null default now(),
  setpoint integer not null,
  source text not null,
  label text not null
);

create index if not exists setpoint_changes_changed_at_idx on public.setpoint_changes (changed_at desc);

create table if not exists private.switchbot_credentials (
  id int primary key default 1 check (id = 1),
  token text not null,
  secret text not null,
  updated_at timestamptz not null default now()
);

alter table public.shared_state enable row level security;
alter table public.press_lease enable row level security;
alter table public.meter_reads enable row level security;
alter table public.setpoint_changes enable row level security;
alter table private.switchbot_credentials enable row level security;

create or replace function public.read_shared_state()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'version', version,
    'virtualSetpoint', virtual_setpoint,
    'catchupFrom', catchup_from,
    'mode', mode,
    'hold', hold,
    'settings', settings,
    'deviceMap', device_map,
    'presets', presets,
    'events', events,
    'records', records,
    'schedulePhase', schedule_phase,
    'catchupNote', catchup_note,
    'roomLabel', room_label
  )
  from public.shared_state
  where id = 1;
$$;

create or replace function public.patch_shared_state(p_version int, p_patch jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  current_version int;
begin
  select version into current_version from public.shared_state where id = 1 for update;
  if p_version is not null and current_version <> p_version then
    return null;
  end if;
  update public.shared_state set
    version = version + 1,
    virtual_setpoint = case when jsonb_exists(p_patch, 'virtualSetpoint') then (p_patch->>'virtualSetpoint')::int else virtual_setpoint end,
    catchup_from = case when jsonb_exists(p_patch, 'catchupFrom') then (p_patch->>'catchupFrom')::timestamptz else catchup_from end,
    mode = case when jsonb_exists(p_patch, 'mode') then p_patch->>'mode' else mode end,
    hold = case when jsonb_exists(p_patch, 'hold') then p_patch->'hold' else hold end,
    settings = case when jsonb_exists(p_patch, 'settings') then p_patch->'settings' else settings end,
    device_map = case when jsonb_exists(p_patch, 'deviceMap') then p_patch->'deviceMap' else device_map end,
    presets = case when jsonb_exists(p_patch, 'presets') then p_patch->'presets' else presets end,
    events = case when jsonb_exists(p_patch, 'events') then p_patch->'events' else events end,
    records = case when jsonb_exists(p_patch, 'records') then p_patch->'records' else records end,
    schedule_phase = case when jsonb_exists(p_patch, 'schedulePhase') then p_patch->>'schedulePhase' else schedule_phase end,
    catchup_note = case when jsonb_exists(p_patch, 'catchupNote') then p_patch->>'catchupNote' else catchup_note end,
    room_label = case when jsonb_exists(p_patch, 'roomLabel') then coalesce(p_patch->>'roomLabel', room_label) else room_label end,
    updated_at = now()
  where id = 1;
  return public.read_shared_state();
end;
$$;

create or replace function public.acquire_press_lease(p_owner text, p_ttl_seconds int)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  updated_rows int;
begin
  update public.press_lease
  set owner = p_owner,
      phase = 'running',
      lease_until = now() + make_interval(secs => p_ttl_seconds),
      cancel_requested = false,
      progress = null,
      updated_at = now()
  where id = 1
    and (phase = 'idle' or lease_until is null or lease_until < now());
  get diagnostics updated_rows = row_count;
  return updated_rows = 1;
end;
$$;

create or replace function public.touch_press_lease(p_owner text, p_ttl_seconds int)
returns void
language sql
security definer
set search_path = public
as $$
  update public.press_lease
  set lease_until = now() + make_interval(secs => p_ttl_seconds),
      updated_at = now()
  where id = 1 and owner = p_owner and phase = 'running';
$$;

create or replace function public.read_press_lease()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'phase', phase,
    'owner', owner,
    'cancelRequested', cancel_requested,
    'leaseUntil', lease_until,
    'progress', progress
  )
  from public.press_lease
  where id = 1;
$$;

create or replace function public.write_press_progress(p_owner text, p_progress jsonb)
returns void
language sql
security definer
set search_path = public
as $$
  update public.press_lease
  set progress = p_progress, updated_at = now()
  where id = 1 and owner = p_owner and phase = 'running';
$$;

create or replace function public.request_press_cancel()
returns void
language sql
security definer
set search_path = public
as $$
  update public.press_lease
  set cancel_requested = true, updated_at = now()
  where id = 1 and phase = 'running';
$$;

create or replace function public.release_press_lease(p_owner text)
returns void
language sql
security definer
set search_path = public
as $$
  update public.press_lease
  set phase = 'idle',
      owner = null,
      progress = null,
      cancel_requested = false,
      lease_until = null,
      updated_at = now()
  where id = 1 and (owner = p_owner or owner is null or lease_until < now());
$$;

create or replace function public.insert_meter_read(
  p_at timestamptz,
  p_temp double precision,
  p_humidity double precision,
  p_co2 int
)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.meter_reads (read_at, temperature_f, humidity, co2_ppm, granularity)
  values (p_at, p_temp, p_humidity, p_co2, 'raw');
$$;

create or replace function public.insert_setpoint_change(
  p_at timestamptz,
  p_setpoint int,
  p_source text,
  p_label text
)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.setpoint_changes (changed_at, setpoint, source, label)
  values (p_at, p_setpoint, p_source, p_label);
$$;

create or replace function public.list_meter_reads(p_since timestamptz)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'at', read_at,
    'temperatureF', temperature_f,
    'humidity', humidity,
    'co2Ppm', co2_ppm
  ) order by read_at), '[]'::jsonb)
  from public.meter_reads
  where read_at >= p_since;
$$;

create or replace function public.list_setpoint_changes(p_since timestamptz)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'at', changed_at,
    'setpoint', setpoint,
    'source', source,
    'label', label
  ) order by changed_at), '[]'::jsonb)
  from public.setpoint_changes
  where changed_at >= p_since;
$$;

create or replace function public.prune_meter_reads()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  rolled int := 0;
  deleted int := 0;
begin
  with hourly as (
    insert into public.meter_reads (read_at, temperature_f, humidity, co2_ppm, granularity)
    select date_trunc('hour', read_at), avg(temperature_f), avg(humidity), round(avg(co2_ppm))::int, 'hour'
    from public.meter_reads
    where granularity = 'raw' and read_at < now() - interval '30 days'
    group by 1
    on conflict (read_at, granularity) do update
      set temperature_f = excluded.temperature_f,
          humidity = excluded.humidity,
          co2_ppm = excluded.co2_ppm
    returning 1
  )
  select count(*)::int into rolled from hourly;

  delete from public.meter_reads
  where granularity = 'raw' and read_at < now() - interval '30 days';
  get diagnostics deleted = row_count;

  delete from public.meter_reads
  where granularity = 'hour' and read_at < now() - interval '400 days';

  return jsonb_build_object('rolled', rolled, 'deleted', deleted);
end;
$$;

create or replace function public.save_switchbot_credentials(p_token text, p_secret text)
returns void
language plpgsql
security definer
set search_path = public, private
as $$
begin
  insert into private.switchbot_credentials (id, token, secret, updated_at)
  values (1, p_token, p_secret, now())
  on conflict (id) do update
    set token = excluded.token,
        secret = excluded.secret,
        updated_at = now();
end;
$$;

create or replace function public.service_switchbot_credentials()
returns jsonb
language sql
stable
security definer
set search_path = public, private
as $$
  select jsonb_build_object('token', token, 'secret', secret)
  from private.switchbot_credentials
  where id = 1;
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on all tables in schema public from anon, authenticated';
    execute 'revoke all on all functions in schema public from public, anon, authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on all functions in schema public to service_role';
  end if;
end $$;
