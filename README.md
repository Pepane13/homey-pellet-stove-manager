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

## Roadmap

1. Write commands (power 1–5, shutdown, alarm reset) after validation on hardware.
2. Pellet consumption model, refill advice, monthly bag forecast, cost tracking.
3. Cleaning and professional maintenance tracking (12 months or 1,200 h, whichever comes first).
4. Learning (heat losses, heating rate per power level), anticipation, thermostat control,
   direct regulation mode with fallback.
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
