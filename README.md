# Setpoint

Setpoint is a phone-first thermostat remote. It keeps a virtual setpoint (the number on the physical thermostat display) and changes it by pressing a SwitchBot up bot or down bot. The room sensor is room air. It is never the setpoint, and Setpoint never waits for the room to reach a target.

Demo mode is the default. It runs with simulated devices and needs no SwitchBot account and no server. Live control can run on the phone, or through the shared server described in [DEPLOY.md](DEPLOY.md).

## Run it

```bash
npm install
npm test
npm run typecheck
npm run web
```

`npm run web` serves the app on port 43117. Open it at [http://127.0.0.1:43117](http://127.0.0.1:43117).

Optional, only for live mode with the shared server:

```bash
EXPO_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<the public anon key>
```

Do not put the service role key, the SwitchBot token, or the MCP key in these variables. Demo mode ignores them.

On a phone, use Expo Go:

```bash
npx expo start
```

This project uses Expo SDK 58. Schedules use America/New_York. There is no Bluetooth fallback.

## Demo and live

Demo works in the browser and in Expo Go. The simulated room starts near 68.4°F, 47% humidity, and about 740 ppm CO2. Pull to refresh drifts that room. It does not move the setpoint.

Live control without the two environment variables uses the SwitchBot Open API from the iPhone app. The token stays in the Keychain. Browser calls to SwitchBot are not the supported path.

When both environment variables are set and the app is in live mode, the shared server owns the SwitchBot calls. The phone uploads the token once into a private table, then presses, device lists, and meter reads go through the server. The scheduler on the server keeps running while the phone is asleep. Demo mode never contacts the server.

## Virtual setpoint

1. The first time there is no saved setpoint, Setpoint asks what the thermostat display shows. That becomes the virtual setpoint. It does not press any buttons.
2. The number is saved on the device. Later launches open straight to the thermostat.
3. Recalibrate, from Home or Settings, only when someone has pressed the physical buttons or the count has drifted. It is never a startup prompt once a setpoint is saved.
4. A successful up press adds the step (default 1°F). A successful down press subtracts it.
5. Set to N presses the correct bot `|current - N| / step` times, waiting between presses (default 1000 ms) so the thermostat can register each one.
6. If a press fails, Setpoint stops. It keeps the presses that already succeeded and does not count the failed press or any press not yet sent.
7. If a request was sent and the response was lost, that degree is not counted, the run stops, and Setpoint asks you to check the thermostat. Later schedules still run.
8. Cancel before a press is sent skips it. Cancel during a press lets that press finish, shows "Finishing the current press", and skips the rest.
9. A temporary hold starts only after a manual, set-to, or preset press actually moves the setpoint. A failed press, a cancel before any press, and a preset that is already showing do not start one.
10. Requests that would leave the min/max range (default 50-85°F) or exceed the press cap (default 15) are refused before any press. Targets have to line up with the step.
11. Optional, default off: the first press only wakes the display. That leading press does not change the virtual setpoint, and it counts toward the cap.

## Schedule, skip, and history

Catch-up applies only the latest due target and marks earlier ones missed. A note such as "Sleep was missed, applied Wake." shows on Home and Schedule. Only a time or temperature edit resets the catch-up cursor.

The Home chip says Following schedule, a hold, or Off schedule. Off schedule means the tracked setpoint does not match the current scheduled target. Tap it to retry. The chip does not use the meter.

Skip the next occurrence of a schedule, or skip one date. Both are undoable. Sleep now and Wake now apply that target immediately through the same press path and mark that occurrence done early or late. They are not a hold, and the next normal occurrence still runs.

Room History charts temperature, humidity, and CO2 for a day or a week, with markers where the setpoint changed. Demo history is stored on the phone. Live history is stored by the server. See [DEPLOY.md](DEPLOY.md).

## SwitchBot token

In the SwitchBot app: Profile, Preferences, About, tap the app version about 10 times, Developer Options, token and secret.

Remote control needs a SwitchBot Hub near the devices, with cloud service enabled. Bots should be in Press Mode. The meter is a Meter Pro (CO2). It is read-only.

On iOS the token and secret are stored in the Keychain via `expo-secure-store` when the server is not configured. On the web they stay in `sessionStorage` for the tab only, which is not a safe place for a real token. The secret is masked after you save it. Nothing in this repo contains a token.
