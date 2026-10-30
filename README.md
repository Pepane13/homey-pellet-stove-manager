# Pellet Stove Manager for Homey

Homey Pro app to monitor and manage pellet stoves driven by a **Duepi EVO** controller board
(Interstoves, and other brands using the myDPRemote app), using the stove's **original WiFi module**.

> **Status: 0.6.** The app reads the stove and the temperature sensors, learns the house, tracks pellets and
> maintenance and can regulate through the Netatmo thermostat. Write commands to the stove (power, on/off,
> alarm reset) exist but are **off by default**: enable « Allow commands to the stove » in the device settings
> only after testing them on site, in front of the stove.

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

## Pellets, cleaning and maintenance (0.4)

Consumption is integrated from the power level (0.95 kg/h at P1 to 2.33 kg/h at P5, times a factor learnt
only when the tank really runs empty, error 5). Flow cards: « Tank refilled » (full tank, 19 kg), bag price,
« Cleaning done », « Professional maintenance done »; triggers for low pellets, evening refill advice,
monthly bag forecast (1st of the month; the daily need is learnt from the power levels actually used, day by day, against the outdoor temperature), cleaning soon/due, maintenance soon/due (12 months or 1,200 h)
and the mid-season chimney sweeping reminder. The settings page shows the counters and the service journal.

## Regulation and commands (0.5)

- **Flows** (default): the app controls nothing.
- **Netatmo compensated setpoint**: while a temperature is held (« Hold [21] °C in the living room »), the
  thermostat setpoint is the target minus the smoothed living-room/thermostat gap (bounded, 0.5 °C steps,
  at most every 10 minutes, written again if the thermostat went back to its schedule). « Stop holding »
  puts the thermostat back on its schedule.
- **Direct**: the app switches the stove itself with a hysteresis on the living room (−0.3/+0.2 °C) while the
  thermostat is kept at a high manual setpoint; if the stove, the commands or the comfort sensor are not
  available, the thermostat goes back to its schedule and « Regulation fell back » is triggered.
- **Automatic power** (option): power = 1 + 2 × (target − living room), bounded, at most every 10 minutes.
- The heating rate is also learnt per power level and used by the anticipation once seen three times.

Commands (`F00n0` power n, `F0000` off, `D6000` alarm reset) are refused while « Allow commands to the
stove » is off.

## Dashboard widget (0.6)

« Pellet stove » widget: status and power, living-room / thermostat / outdoor temperatures, pellets left
with the estimated empty time, month consumption and cost with the bag forecast, cleaning and service counters.

## Release (no computer needed)

1. Bump `version` in `package.json`, `.homeycompose/app.json` and `app.json`, and add the en + fr entry
   for that version in `.homeychangelog.json`.
2. Push to `main`: the **Publish to the Homey App Store** workflow runs the tests and the publish-level
   validation, then, if the version has no `vX.Y.Z` tag yet, publishes it and creates the tag
   (needs the `HOMEY_PAT` repository secret, token from https://tools.developer.homey.app/me).
   Pull requests only run the tests and validation.
3. In the developer tools, move the build to **Test**, then install or update it from
   https://homey.app/a/com.pepane13.pelletstove/test/.

## Roadmap

1. On-site test of the write commands, then direct mode and automatic power in daily use.
2. Fully local connection to the original WiFi module (see Security notes).

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
- **Local mode with the original WiFi module.** The module only connects outbound to the vendor relay.
  Redirecting `1.duepiwebserver1.com` to a local server (DNS override on the router) would make a fully local
  mode possible, but it needs a capture of the exchange between the module and the relay (login, keep-alive,
  who speaks first), which has not been done yet. Until then, the only local option is a serial bridge
  (ESP-Link / ser2net) on the stove board.
- `npm audit` reports 4 moderate alerts, all from `homey-api` → `socket.io-client@2` → `parseuri` (ReDoS when
  parsing a hostile URL). The app only connects to its own Homey's local API, so the risk is negligible; no
  `homey-api` version fixes it yet (3.21.2 has the same dependency).
- CI uses exact versions: `homey@4.6.2`, and the GitHub actions pinned by commit.

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
