create index if not exists setpoint_changes_changed_at_id_idx on public.setpoint_changes (changed_at desc, id desc);

create or replace function public.list_setpoint_changes_page(
  p_before_at timestamptz default null,
  p_before_id bigint default null,
  p_limit int default 20
)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', id,
    'at', changed_at,
    'setpoint', setpoint,
    'source', source,
    'label', label
  ) order by changed_at desc, id desc), '[]'::jsonb)
  from (
    select id, changed_at, setpoint, source, label
    from public.setpoint_changes
    where p_before_at is null
      or (changed_at, id) < (p_before_at, coalesce(p_before_id, 9223372036854775807))
    order by changed_at desc, id desc
    limit greatest(1, least(coalesce(p_limit, 20), 101))
  ) page;
$$;

revoke all on function public.list_setpoint_changes_page(timestamptz, bigint, int) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.list_setpoint_changes_page(timestamptz, bigint, int) from anon, authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.list_setpoint_changes_page(timestamptz, bigint, int) to service_role';
  end if;
end $$;
