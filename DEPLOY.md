# Deploy the shared Setpoint server

The Supabase project already exists. Name `setpoint`, ref `rdyjczebydnmfvbgylya`. This repo does not deploy it. Apply the SQL, deploy the functions, and set the secrets after review. Do not commit secret values, and do not paste them into logs.

The server owns SwitchBot when the app is in live mode and `EXPO_PUBLIC_SUPABASE_URL` plus `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY` are set. The token is stored in `private.switchbot_credentials` (written by the `credentials` function) or, if that row is empty, in the function secrets `SWITCHBOT_TOKEN` and `SWITCHBOT_SECRET`. Demo mode never calls the server. Live mode without those app env vars still uses the phone Keychain, so the app works before this deploy.

Every press from the app, the scheduler, and the MCP server goes through one press-session function. A single lease row expires, so a crash cannot lock the house forever.

## 1. Apply the database

From this repo, with the Supabase CLI logged in as an owner of the project:

```bash
supabase link --project-ref rdyjczebydnmfvbgylya
supabase db push
```

That applies `supabase/migrations/20261111120000_setpoint.sql`. It creates the shared state row, the press lease, meter reads, setpoint changes, and the private credential table. Row level security is on and there are no anon policies. The functions run as the owner and are granted to `service_role` only.

## 2. Set function secrets

Set these names in the function secret store. Do not put the values in the repo.

- `SWITCHBOT_TOKEN`
- `SWITCHBOT_SECRET`
- `SETPOINT_MCP_KEY`
- `CRON_SECRET`

`SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` are injected by the platform. The service role key stays on the server. The app never sees it.

```bash
supabase secrets set SWITCHBOT_TOKEN SWITCHBOT_SECRET SETPOINT_MCP_KEY CRON_SECRET
```

The CLI prompts for the values. `SWITCHBOT_TOKEN` and `SWITCHBOT_SECRET` can be omitted when the phone will upload them through Settings. The scheduler still needs one of the two sources before it can press.

## 3. Deploy the functions

`supabase/config.toml` sets `verify_jwt = false` for every function. Each function checks its own credential:

- App functions (`state`, `press`, `session`, `history`, `credentials`, `devices`, and `meter` when the phone calls it) require the `apikey` header or `Authorization: Bearer` to match `SUPABASE_ANON_KEY`.
- Cron functions (`tick`, `meter`, `prune`) require the header `x-setpoint-cron-secret` to match `CRON_SECRET`.
- `mcp` requires `Authorization: Bearer` to match `SETPOINT_MCP_KEY`.

```bash
supabase functions deploy state
supabase functions deploy press
supabase functions deploy session
supabase functions deploy tick
supabase functions deploy meter
supabase functions deploy history
supabase functions deploy credentials
supabase functions deploy devices
supabase functions deploy prune
supabase functions deploy mcp
```

## 4. Schedule the jobs

Store two Vault secrets, then run `supabase/cron.sql` in the SQL editor.

- `setpoint_functions_base`: `https://rdyjczebydnmfvbgylya.supabase.co/functions/v1` (no trailing slash)
- `setpoint_cron_secret`: the same value as `CRON_SECRET`

```sql
select vault.create_secret('https://rdyjczebydnmfvbgylya.supabase.co/functions/v1', 'setpoint_functions_base');
select vault.create_secret('<the CRON_SECRET value>', 'setpoint_cron_secret');
```

Replace the cron secret placeholder in the editor. Do not save that statement.

Then run the contents of `supabase/cron.sql`. It enables `pg_cron` and `pg_net` and schedules:

| Job | When | Function |
| --- | --- | --- |
| `setpoint-schedule-tick` | every minute | `POST /tick` |
| `setpoint-meter-read` | every 10 minutes | `POST /meter` |
| `setpoint-prune-reads` | 04:15 UTC daily | `POST /prune` |

The tick honors skips, run-now done marks, catch-up (latest due target only), and holds. It presses only when shared mode is `live`. The meter job stores temperature, humidity, and CO2. The prune job keeps raw reads for 30 days, then rolls them into hourly averages. Hourly rows older than 400 days are deleted.

The phone also requests a meter read when the app opens.

## 5. Point the app at the project

```bash
EXPO_PUBLIC_SUPABASE_URL=https://rdyjczebydnmfvbgylya.supabase.co
EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<the public anon key>
```

Use the public anon key, the same value the edge runtime sees as `SUPABASE_ANON_KEY`. It is a public client key, not the service role key. Open Settings, enter the SwitchBot token and secret, and save. That uploads them to the private table and switches the app to live mode only if the device list loads.

## 6. Connect an MCP client

URL:

```text
https://rdyjczebydnmfvbgylya.supabase.co/functions/v1/mcp
```

Header:

```text
Authorization: Bearer <SETPOINT_MCP_KEY>
```

Send JSON-RPC over HTTP `POST` with `Content-Type: application/json`. The function also accepts `Accept: application/json`. If the gateway asks for an `apikey` header, send the public anon key there. The function does not treat that header as the MCP secret.

Tools: `set_to`, `nudge`, `read_room`, `room_history`, `show_schedule`, `edit_schedule`, `skip_wake` (pass `undoKey` to undo), `run_schedule_now`, `status`.

A client starts with `initialize`, then `notifications/initialized`, then `tools/list` and `tools/call`.

## Local tests

Docker was not available in the environment that added this server, so the suite does not boot the Supabase CLI stack. `npm test` loads the migration into PGlite and runs the press lease, the scheduler, skips, run-now, meter prune, and the MCP tools against those rows. The edge entrypoints are thin wrappers around the same handlers.
