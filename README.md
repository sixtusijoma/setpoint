# Setpoint

Setpoint is a phone-first thermostat remote. It keeps a **virtual setpoint** — the number on the physical thermostat display — and changes it by pressing a SwitchBot up bot or down bot. The room sensor is room air. It is never the setpoint, and Setpoint never waits for the room to reach a target.

Demo mode is the default. It runs with simulated devices and needs no SwitchBot account. Live control uses the SwitchBot Open API from the iPhone app.

## Run it

```bash
npm install
npm test
npm run typecheck
npm run web
```

`npm run web` serves the app on port **43117**. Open it at [http://127.0.0.1:43117](http://127.0.0.1:43117).

On a phone, use Expo Go:

```bash
npx expo start
```

This project uses Expo SDK 58.

## Demo and live

Demo works in the browser and in Expo Go. The simulated room starts near 68.4°F, 47% humidity, and about 740 ppm CO2. Pull to refresh drifts that room. It does not move the setpoint.

Live control is the iOS / Expo Go path. The phone talks to `https://api.switch-bot.com/v1.1` directly. There is no backend, proxy, or cloud cron. Browser calls to the SwitchBot API are not the supported path; if one fails, Setpoint says cloud control from the browser is blocked.

iOS will not reliably fire network calls at an exact time while the app is suspended. Schedules run while Setpoint is open, and when you bring it back to the foreground. Local notifications remind you to open the app. That is the v1 behavior.

## Virtual setpoint

1. The first time there is no saved setpoint, Setpoint asks what the thermostat display shows. That becomes the virtual setpoint. It does not press any buttons.
2. The number is saved on the device. Later launches open straight to the thermostat.
3. Recalibrate, from Home or Settings, only when someone has pressed the physical buttons or the count has drifted. It is never a startup prompt once a setpoint is saved.
4. A successful up press adds the step (default 1°F). A successful down press subtracts it.
5. Set to N presses the correct bot `|current − N| / step` times, waiting between presses (default 1000 ms) so the thermostat can register each one.
6. If a press fails, Setpoint stops. It keeps the presses that already succeeded and does not count the failed press or any press not yet sent.
7. Requests that would leave the min/max range (default 50–85°F) or exceed the press cap (default 15) are refused before any press. Targets have to line up with the step.
8. Optional, default off: the first press only wakes the display. That leading press does not change the virtual setpoint, and it counts toward the cap.

## SwitchBot token

In the SwitchBot app: Profile → Preferences → About → tap the app version about 10 times → Developer Options → token and secret.

Remote control needs a SwitchBot Hub near the devices, with cloud service enabled. Bots should be in Press Mode. The meter is a Meter Pro (CO2); it is read-only.

On iOS the token and secret are stored in the Keychain via `expo-secure-store`. On the web they stay in `sessionStorage` for the tab only, which is not a safe place for a real token. The secret is masked after you save it. Nothing in this repo contains a token.
