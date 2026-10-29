# Pellet Stove Manager for Homey

Homey Pro app to monitor and manage pellet stoves driven by a **Duepi EVO** controller board
(Interstoves, and other brands using the myDPRemote app), using the stove's **original WiFi module**.

> **Status: 0.2 – read-only.** The app reads the stove and the room/outdoor temperature sensors; it does not send any command yet.
> Write commands (power level, on/off, alarm reset) will be enabled once tested on real hardware.

## Features (0.1)

- Pairing with the device code printed on the WiFi module box (same code as myDPRemote).
- Connection modes:
  - **Duepi cloud relay** (`1.duepiwebserver1.com:3000`, as used by myDPRemote) – encrypted frames, one long-lived session, gentle polling (60 s by default) and exponential back-off.
  - **Local serial bridge** (ESP-Link / ser2net on the stove's serial connector) – plain frames, no cloud.
  - **Simulator** – a virtual stove for testing Flows without hardware.
- Capabilities: stove status, alarm and error message, power level, flue gas and board temperatures,
  auger speed, exhaust fan speed, **total burn hours** and **hours since last service** (read from the board).
- Flow cards: alarm raised / cleared, status changed, connection lost; conditions "is heating", "has an alarm".
- English and French.

The ambient probe value 99.9 °C ("no probe connected", e.g. when the stove is driven by an external
thermostat) is ignored.

## Temperature sensors (0.2)

In the app settings, choose for each role any temperature sensor available on your Homey
(any device and any temperature capability): comfort sensor (optionally averaged with a second one),
thermostat sensor, outdoor reference sensor, outdoor backup sensor and a weather forecast device.
Each reading is validated (implausible or frozen value, device switched off); the outdoor backup
bias is learnt and removed when the reference fails. The values appear on the stove device and in Insights.
This uses the `homey:manager:api` permission (read-only access to the other devices).

## Météo-France forecast (0.2.1)

The forecast can come from the Homey weather device or from Météo-France (AROME 1.5/2.5 km,
blended with ARPEGE beyond two days) through the free [Open-Meteo](https://open-meteo.com) API
(`meteofrance_seamless`, no key, non-commercial use). The Homey location, rounded to about 1 km, is
sent once an hour (`homey:manager:geolocation` permission). If Open-Meteo is unreachable, the last
forecast is kept for 6 hours, then the weather device is used. The mean error and bias of each
forecast against the outdoor reference sensor are measured hourly and shown in the settings.

## Learning and anticipation (0.3)

Per indoor sensor (comfort and thermostat), the app learns three parameters of a simple model
(`dT/dt = G − k·(T − Tout)` while heating, `−k·(T − Tout)` when off):

- **losses `k`**, measured on quiet nights with the stove off (21:00–08:00, one hour after it stopped,
  at least 3 hours, indoor/outdoor difference of 5 K or more);
- **heating gain `G`** and **ignition lag**, measured on each heat-up (heat-ups started between
  10:00 and 16:00 are ignored because of the sun);
- sudden drops (window open), implausible values and outliers are rejected.

Starting values come from the analysis of the consumption history; each one counts as three
observations, then the estimate follows a moving average over about twenty. From these parameters,
the current temperature and the outdoor forecast (Météo-France curve corrected by its measured bias,
or the trend towards the 6-hour minimum), the app computes continuously the latest start time that
reaches a target temperature at a target time. Targets come from the Flow action « Reach [21] °C at [06:20] »
(0.3.1); the trigger « It is time to start heating for a target » is raised at the computed time and the
Flow switches the thermostat. A preview target in the settings is used when no Flow target is pending.
The app itself controls nothing.

## Insulation follow-up (0.3.2)

Every accepted quiet night gives one heat-loss point per sensor, expressed as °C lost per hour for a
10 °C indoor/outdoor difference. The stove device shows the last night and the 14-night median
(both in Insights), and the settings page draws the curve and compares the medians before and after
the date of insulation works. Resetting the learning keeps this curve.

## Release (no computer needed)

1. GitHub → Actions → **Update Homey App Version**: choose patch/minor/major and write the changelog
   (bumps the version, commits, tags and creates a GitHub release).
2. GitHub → Actions → **Publish Homey App**: builds and uploads a Draft to the Homey developer tools
   (needs the `HOMEY_PAT` repository secret, token from https://tools.developer.homey.app/me).
3. In the developer tools, move the build to **Test**, then install or update it from
   https://homey.app/a/com.pepane13.pelletstove/test/.

## Roadmap

1. Write commands (power 1–5, shutdown, alarm reset) after validation on hardware.
2. Pellet consumption model, refill advice, monthly bag forecast, cost tracking.
3. Cleaning and professional maintenance tracking (12 months or 1,200 h, whichever comes first).
4. Thermostat control from Flow targets, heating rate per power level, direct regulation mode with fallback.
5. Dashboard widget.

## Protocol

Serial frames: `ESC` + `R` + 5-character command + 2-hex checksum + `&`.
The original WiFi module only connects outbound to the Duepi relay; after a `master:<code>#` login,
each frame is sent as `ESC` + Base64(IV ‖ AES-128-CBC(frame)) + `&`, with
`key = MD5(device code) XOR 23FADC18A422678312C86AC29281AC01`.

Credits for the community protocol documentation:
[aceindy/Duepi_EVO](https://github.com/aceindy/Duepi_EVO),
P. Bornat ("InterstoveRemoteCmd"),
[motionbug/testcodestove](https://github.com/motionbug/testcodestove) (encryption notes, MIT).
The implementation in this repository is original.

## Security notes

- The device code is a credential: anyone who knows it can control the stove through the vendor relay.
  The app stores it only in the device store on your Homey and never logs it.
- The vendor relay protocol sends the device code in clear text over the Internet (this is how myDPRemote works).
  The local bridge mode avoids this.

## Development

```bash
npm test                         # unit tests (codec vector, decoders, transport against a fake relay)
homey app validate --level publish
homey app run                    # on your Homey Pro
```

## Disclaimer

Not affiliated with, endorsed by or supported by Duepi, Interstoves or any stove manufacturer.
Use at your own risk; the vendor may change its relay at any time.

## Licence

GPL-3.0-or-later – see [LICENSE](LICENSE).
