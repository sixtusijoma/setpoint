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
        when p_bucket_seconds = 86400 then date_trunc('day', read_at, 'America/New_York')
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

create or replace function public.meter_read_bounds()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object('firstAt', min(read_at), 'lastAt', max(read_at))
  from public.meter_reads;
$$;

revoke all on function public.meter_read_bounds() from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.meter_read_bounds() from anon, authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.meter_read_bounds() to service_role';
  end if;
end $$;
