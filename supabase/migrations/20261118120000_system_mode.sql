alter table public.shared_state
  add column if not exists system_mode text not null default 'unknown',
  add column if not exists heat_setpoint int,
  add column if not exists cool_setpoint int,
  add column if not exists battery_cache jsonb;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'shared_state_system_mode_check') then
    alter table public.shared_state
      add constraint shared_state_system_mode_check
      check (system_mode in ('heat', 'off', 'cool', 'unknown'));
  end if;
end $$;

-- The old single setpoint is copied onto both Heat and Cool. The mode stays
-- unknown until someone says which one the thermostat is actually in.
update public.shared_state
set heat_setpoint = virtual_setpoint
where heat_setpoint is null;

update public.shared_state
set cool_setpoint = virtual_setpoint
where cool_setpoint is null;

update public.shared_state
set device_map = device_map || '{"mode":null}'::jsonb
where not (device_map ? 'mode');

update public.shared_state
set settings = settings || '{"modeStep":2}'::jsonb
where not (settings ? 'modeStep');

create or replace function public.read_shared_state()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'version', version,
    'virtualSetpoint', case
      when system_mode = 'heat' then heat_setpoint
      when system_mode = 'cool' then cool_setpoint
      else null
    end,
    'systemMode', system_mode,
    'heatSetpoint', heat_setpoint,
    'coolSetpoint', cool_setpoint,
    'batteryCache', battery_cache,
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
  next_system text;
  next_heat int;
  next_cool int;
  next_virtual int;
  wrote_virtual boolean;
begin
  select version into current_version from public.shared_state where id = 1 for update;
  if p_version is not null and current_version <> p_version then
    return null;
  end if;

  select system_mode, heat_setpoint, cool_setpoint
  into next_system, next_heat, next_cool
  from public.shared_state
  where id = 1;

  if jsonb_exists(p_patch, 'systemMode') then
    next_system := p_patch->>'systemMode';
  end if;
  if next_system is null or next_system not in ('heat', 'off', 'cool', 'unknown') then
    raise exception 'Thermostat mode must be heat, off, cool, or unknown.';
  end if;

  if jsonb_exists(p_patch, 'heatSetpoint') then
    next_heat := (p_patch->>'heatSetpoint')::int;
  end if;
  if jsonb_exists(p_patch, 'coolSetpoint') then
    next_cool := (p_patch->>'coolSetpoint')::int;
  end if;

  wrote_virtual := jsonb_exists(p_patch, 'virtualSetpoint');
  if wrote_virtual then
    next_virtual := (p_patch->>'virtualSetpoint')::int;
    if next_system = 'heat' then
      next_heat := next_virtual;
    elsif next_system = 'cool' then
      next_cool := next_virtual;
    else
      next_heat := next_virtual;
      next_cool := next_virtual;
    end if;
  end if;

  if next_system = 'heat' then
    next_virtual := next_heat;
  elsif next_system = 'cool' then
    next_virtual := next_cool;
  else
    next_virtual := null;
  end if;

  update public.shared_state set
    version = version + 1,
    virtual_setpoint = next_virtual,
    system_mode = next_system,
    heat_setpoint = next_heat,
    cool_setpoint = next_cool,
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

create or replace function public.save_battery_cache(p_cache jsonb)
returns jsonb
language sql
security definer
set search_path = public
as $$
  update public.shared_state
  set battery_cache = p_cache,
      updated_at = now()
  where id = 1
  returning battery_cache;
$$;

revoke all on function public.save_battery_cache(jsonb) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.save_battery_cache(jsonb) from anon, authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.read_shared_state() to service_role';
    execute 'grant execute on function public.patch_shared_state(int, jsonb) to service_role';
    execute 'grant execute on function public.save_battery_cache(jsonb) to service_role';
  end if;
end $$;
