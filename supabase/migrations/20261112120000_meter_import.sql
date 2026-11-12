alter table public.meter_reads
  add column if not exists origin text not null default 'live' check (origin in ('live', 'import'));

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
  values (p_at, p_temp, p_humidity, p_co2, 'raw')
  on conflict (read_at, granularity) do nothing;
$$;

drop function if exists public.list_meter_reads(timestamptz);

create or replace function public.list_meter_reads(
  p_since timestamptz,
  p_until timestamptz default null,
  p_bucket_seconds int default 0
)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'at', bucket,
    'temperatureF', temperature_f,
    'humidity', humidity,
    'co2Ppm', co2_ppm
  ) order by bucket), '[]'::jsonb)
  from (
    select
      case
        when p_bucket_seconds > 0 then to_timestamp(floor(extract(epoch from read_at) / p_bucket_seconds) * p_bucket_seconds)
        else read_at
      end as bucket,
      round(avg(temperature_f)::numeric, 1)::float8 as temperature_f,
      round(avg(humidity)::numeric, 1)::float8 as humidity,
      round(avg(co2_ppm))::int as co2_ppm
    from public.meter_reads
    where read_at >= p_since
      and (p_until is null or read_at <= p_until)
    group by 1
  ) rolled;
$$;

drop function if exists public.list_setpoint_changes(timestamptz);

create or replace function public.list_setpoint_changes(
  p_since timestamptz,
  p_until timestamptz default null
)
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
  where changed_at >= p_since
    and (p_until is null or changed_at <= p_until);
$$;

create or replace function public.import_meter_reads(p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  inserted int := 0;
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    return jsonb_build_object('inserted', 0);
  end if;
  with incoming as (
    select distinct on ((item->>'at')::timestamptz)
      (item->>'at')::timestamptz as read_at,
      (item->>'temperatureF')::float8 as temperature_f,
      (item->>'humidity')::float8 as humidity,
      (item->>'co2Ppm')::int as co2_ppm
    from jsonb_array_elements(p_rows) as item
    where item->>'at' is not null
    order by (item->>'at')::timestamptz
  ),
  written as (
    insert into public.meter_reads (read_at, temperature_f, humidity, co2_ppm, granularity, origin)
    select read_at, temperature_f, humidity, co2_ppm, 'raw', 'import'
    from incoming
    on conflict (read_at, granularity) do nothing
    returning 1
  )
  select count(*)::int into inserted from written;
  return jsonb_build_object('inserted', inserted);
end;
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
    insert into public.meter_reads (read_at, temperature_f, humidity, co2_ppm, granularity, origin)
    select date_trunc('hour', read_at), avg(temperature_f), avg(humidity), round(avg(co2_ppm))::int, 'hour', 'live'
    from public.meter_reads
    where granularity = 'raw' and origin = 'live' and read_at < now() - interval '30 days'
    group by 1
    on conflict (read_at, granularity) do update
      set temperature_f = excluded.temperature_f,
          humidity = excluded.humidity,
          co2_ppm = excluded.co2_ppm
    returning 1
  )
  select count(*)::int into rolled from hourly;

  delete from public.meter_reads
  where granularity = 'raw' and origin = 'live' and read_at < now() - interval '30 days';
  get diagnostics deleted = row_count;

  delete from public.meter_reads
  where granularity = 'hour' and origin = 'live' and read_at < now() - interval '400 days';

  return jsonb_build_object('rolled', rolled, 'deleted', deleted);
end;
$$;

revoke all on function public.insert_meter_read(timestamptz, double precision, double precision, int) from public;
revoke all on function public.list_meter_reads(timestamptz, timestamptz, int) from public;
revoke all on function public.list_setpoint_changes(timestamptz, timestamptz) from public;
revoke all on function public.import_meter_reads(jsonb) from public;
revoke all on function public.prune_meter_reads() from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.insert_meter_read(timestamptz, double precision, double precision, int) from anon, authenticated';
    execute 'revoke all on function public.list_meter_reads(timestamptz, timestamptz, int) from anon, authenticated';
    execute 'revoke all on function public.list_setpoint_changes(timestamptz, timestamptz) from anon, authenticated';
    execute 'revoke all on function public.import_meter_reads(jsonb) from anon, authenticated';
    execute 'revoke all on function public.prune_meter_reads() from anon, authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.insert_meter_read(timestamptz, double precision, double precision, int) to service_role';
    execute 'grant execute on function public.list_meter_reads(timestamptz, timestamptz, int) to service_role';
    execute 'grant execute on function public.list_setpoint_changes(timestamptz, timestamptz) to service_role';
    execute 'grant execute on function public.import_meter_reads(jsonb) to service_role';
    execute 'grant execute on function public.prune_meter_reads() to service_role';
  end if;
end $$;
