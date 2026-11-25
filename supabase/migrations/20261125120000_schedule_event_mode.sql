-- Each schedule event is one object in shared_state.events. mode is optional:
-- omitted or null leaves the thermostat mode alone; heat, cool, and off switch it.

create or replace function public.schedule_event_modes_ok(events jsonb)
returns boolean
language sql
immutable
set search_path = public
as $$
  select coalesce(
    bool_and(
      case
        when jsonb_typeof(event) <> 'object' then false
        when not jsonb_exists(event, 'mode') then true
        when jsonb_typeof(event -> 'mode') = 'null' then true
        else event ->> 'mode' in ('heat', 'cool', 'off')
      end
    ),
    true
  )
  from jsonb_array_elements(events) as event;
$$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'shared_state_events_mode_check'
      and conrelid = 'public.shared_state'::regclass
  ) then
    alter table public.shared_state
      add constraint shared_state_events_mode_check
      check (public.schedule_event_modes_ok(events));
  end if;
end $$;

revoke all on function public.schedule_event_modes_ok(jsonb) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.schedule_event_modes_ok(jsonb) from anon, authenticated';
  end if;
end $$;
