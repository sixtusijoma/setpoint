-- Schedule the shared server after the edge functions are deployed.
-- Do not put secret values in this file. Store them in Vault first:
--   setpoint_functions_base  the functions base URL, with no trailing slash
--   setpoint_cron_secret     the same value as the CRON_SECRET function secret
--
-- Example (run in the SQL editor, substituting the real values there, not here):
--   select vault.create_secret('<functions base URL>', 'setpoint_functions_base');
--   select vault.create_secret('<cron secret>', 'setpoint_cron_secret');

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule(jobid)
from cron.job
where jobname in ('setpoint-schedule-tick', 'setpoint-meter-read', 'setpoint-prune-reads');

select cron.schedule(
  'setpoint-schedule-tick',
  '* * * * *',
  $job$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'setpoint_functions_base') || '/tick',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-setpoint-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'setpoint_cron_secret')
    ),
    body := '{}'::jsonb
  );
  $job$
);

select cron.schedule(
  'setpoint-meter-read',
  '*/10 * * * *',
  $job$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'setpoint_functions_base') || '/meter',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-setpoint-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'setpoint_cron_secret')
    ),
    body := '{}'::jsonb
  );
  $job$
);

select cron.schedule(
  'setpoint-prune-reads',
  '15 4 * * *',
  $job$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'setpoint_functions_base') || '/prune',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-setpoint-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'setpoint_cron_secret')
    ),
    body := '{}'::jsonb
  );
  $job$
);
