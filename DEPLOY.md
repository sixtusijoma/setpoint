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

That applies `supabase/migrations/20261111120000_setpoint.sql`, `supabase/migrations/20261112120000_meter_import.sql`, and `supabase/migrations/20261112180000_setpoint_change_pages.sql`. The first creates the shared state row, the press lease, meter reads, setpoint changes, and the private credential table. The second adds an `origin` column (`live` or `import`) on meter reads, the `import_meter_reads` function, and `since` / `until` arguments on the history functions. The third adds an index on setpoint changes by time and the `list_setpoint_changes_page` function that the History list pages through. Row level security is on and there are no anon policies. The functions run as the owner and are granted to `service_role` only.

## 2. Set function secrets

Set these names in the function secret store. Do not put the values in the repo.

- `SWITCHBOT_TOKEN`
- `SWITCHBOT_SECRET`
- `SETPOINT_APP_KEY`
- `SETPOINT_MCP_KEY`
- `CRON_SECRET`

`SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` are injected by the platform. The service role key stays on the server. The app never sees it.

`SETPOINT_APP_KEY` is the private key the phone sends. The function hashes it with SHA-256 at startup and keeps that hash for comparisons. The raw value is not copied onto the request environment object. Do not put this key in `EXPO_PUBLIC_*`, the app bundle, or a log.

Optional: `SETPOINT_WEB_ORIGIN`, an exact browser origin such as `http://127.0.0.1:43117`. Leave it unset for the native app. The functions do not send `Access-Control-Allow-Origin: *`.

```bash
supabase secrets set SWITCHBOT_TOKEN SWITCHBOT_SECRET SETPOINT_APP_KEY SETPOINT_MCP_KEY CRON_SECRET
```

The CLI prompts for the values. `SWITCHBOT_TOKEN` and `SWITCHBOT_SECRET` can be omitted when the phone will upload them through Settings. The scheduler still needs one of the two sources before it can press. Generate `SETPOINT_APP_KEY` yourself and enter the same value once in the app. It is stored in the device secure store, not in the Expo project.

## 3. Deploy the functions

`supabase/config.toml` sets `verify_jwt = false` for every function. Each function checks its own credential in one helper:

- App functions (`state`, `press`, `recalibrate`, `session`, `history`, `import-meter`, `credentials`, `devices`, and `meter` when the phone calls it) require the header `x-setpoint-app-key`. The helper hashes that header and compares it to the stored hash of `SETPOINT_APP_KEY` in constant time. A missing or wrong key returns 401. The public anon key is not enough.
- `import-meter` is `POST`. Send JSON `{ "csv": "<file text>" }` or a raw `text/csv` body. It returns `{ "inserted", "duplicates", "skipped", "firstAt", "lastAt", "skipReasons" }`. `skipReasons` lists up to three sample reasons when `skipped` is greater than 0. It uses the existing `SETPOINT_APP_KEY`. It does not add a secret. `tick` and `prune` stay on `CRON_SECRET`. `mcp` stays on `SETPOINT_MCP_KEY`.
- `history` takes `?span=day|week|month` (or `since` and `until`) and returns `{ "changes", "samples" }` as before. `?view=changes&limit=20&cursor=<nextCursor>` returns one page of setpoint changes, newest first, as `{ "changes", "nextCursor" }`. `limit` is 1 to 100 and defaults to 20. Pass the previous `nextCursor` to get older changes. It is `null` on the last page. A cursor that does not decode returns 400.
- `meter` also accepts `x-setpoint-cron-secret` so the ten-minute job can keep running. A phone call still needs the app key.
- `tick` and `prune` accept only `x-setpoint-cron-secret` matching `CRON_SECRET`.
- `mcp` requires `Authorization: Bearer` to match `SETPOINT_MCP_KEY`. The app key does not open it.

```bash
supabase functions deploy state
supabase functions deploy press
supabase functions deploy recalibrate
supabase functions deploy session
supabase functions deploy tick
supabase functions deploy meter
supabase functions deploy history
supabase functions deploy import-meter
supabase functions deploy credentials
supabase functions deploy devices
supabase functions deploy prune
supabase functions deploy mcp
```

### Upgrading a project that already runs

The paged setpoint change list needs `supabase db push` (for `20261112180000_setpoint_change_pages.sql`) and then `supabase functions deploy history`. The other functions bundle the same shared server code, but their behavior did not change, so they do not need a redeploy. The MCP `room_history` tool is unchanged. Run the migration first: a `history` function deployed before it still answers `?span=` requests, but `?view=changes` fails until the database function exists. An app build that pages the list still works against an older `history` function. It gets every change in one response and shows the end of the list.

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

The tick honors skips, run-now done marks, catch-up (latest due target only), and holds. It presses only when shared mode is `live`. The meter job stores temperature, humidity, and CO2. The prune job keeps live raw reads for 30 days, then rolls those into hourly averages. Live hourly rows older than 400 days are deleted. Rows imported from a meter CSV stay as raw readings and are not rolled or deleted.

The phone also requests a meter read when the app opens.

## 5. Point the app at the project

```bash
EXPO_PUBLIC_SUPABASE_URL=https://rdyjczebydnmfvbgylya.supabase.co
EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<the public anon key>
```

Use the public anon key, the same value the edge runtime sees as `SUPABASE_ANON_KEY`. It is a public client key, not the service role key, and it does not authorize the functions. The first launch asks for `SETPOINT_APP_KEY` and stores it in the secure store. Settings can change or clear that key. Then enter the SwitchBot token and secret. That uploads them to the private table and switches the app to live mode only if the device list loads.

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

Tools: `set_to`, `nudge`, `read_room`, `room_history` (`span` of `day`, `week`, or `month`, or both `since` and `until` as ISO timestamps, 800 days at most), `import_meter_csv` (`csv` is the CSV text; the result is the same summary as `import-meter`), `show_schedule`, `edit_schedule`, `skip_wake` (pass `undoKey` to undo), `run_schedule_now`, `recalibrate` (corrects the tracked setpoint to what the display shows, presses nothing), `status`.

A client starts with `initialize`, then `notifications/initialized`, then `tools/list` and `tools/call`.

## Local tests

Docker was not available in the environment that added this server, so the suite does not boot the Supabase CLI stack. `npm test` loads the migrations into PGlite and runs the press lease, the scheduler, skips, run-now, meter prune, CSV import, history ranges, setpoint change pages, and the MCP tools against those rows. The edge entrypoints are thin wrappers around the same handlers.
