# Protocol Micro v3 — 8-band PEQ controller

Local backend + web UI for the **CrinEar Protocol Micro** USB-C DAC
(`0x3302:0xC20F`). The protocol was derived from the device's Walkplay family
handler and then verified against the hardware — see `PROTOCOL.md`.

Eight bands, ±12 dB, BYPASS / LSHELF / PEAK / HSHELF / LPF / HPF, plus a global pregain
register. Every write is confirmed by a read-back of all eight records.

## Requirements

- Python 3 with `hidapi` (`pip install hidapi`)
- The DAC plugged in (it appears as USB product `Protocol Micro`)

## Run

```bash
python3 -m venv .venv-mac && .venv-mac/bin/pip install hidapi   # once
./run-v3.sh                                                     # → http://127.0.0.1:8766
```

or directly:

```bash
.venv-mac/bin/python v3/server.py            # http://127.0.0.1:8766
.venv-mac/bin/python v3/micro.py --dump      # read the device from the CLI
.venv-mac/bin/python v3/micro.py --set-peq p.json
.venv-mac/bin/python v3/micro.py --set-pregain -3
```

`p.json`: `{"pregain": -3, "bands": [{"freq": 105, "q": 0.7, "gain": 0,
"type": "LSHELF"}, ... x8]}`.

## Tests (no DAC needed)

```bash
.venv-mac/bin/python -m unittest discover -s v3 -p "test_*.py"
node --test micro-dac-extension/test/peq-core.test.js
```

`test_micro.py` pins the coefficient math to eight blobs captured from the real
unit, so a drift in the biquad or the blob layout fails the build.

## HTTP API

| Method | Path | Body | Result |
| ------ | ---- | ---- | ------ |
| GET | `/api/state` | – | firmware, pregain, slot, all 8 bands, `status` |
| GET | `/api/peq` | – | `{bands, pregain, slot}` |
| POST | `/api/peq` | `{"bands": [8 x {freq,q,gain,type}], "pregain": -3}` | per-band `{verified}` + pregain result; **500** if any band fails |
| POST | `/api/pregain` | `{"value": 0..-12}` | `{requested_pregain, readback, verified}` |

Errors: `400` bad input, `503` DAC not present.

## Web UI

Stdlib server + static page in `v3/web/`, no CDN or framework:

- draggable log-frequency response graph using the exact same RBJ math as the
  firmware path (so the curve is what the DSP applies)
- 8 band chips, keyboard editing, double-click to zero a band
- pregain stepper (whole dB, the register has no fractional part)
- AutoEq `ParametricEQ.txt` import: preamp goes to the pregain register, or can
  be folded into the band gains instead
- auto-save with per-band verification, offline banner with reconnect polling

## Known device behaviour

- The firmware stores whatever it is given — no clamping, no error. All limits
  live in software.
- Reading band index ≥ 8 returns uninitialised memory; only 0..7 are valid.
- `eq.hangout.audio` currently rejects this PID as unsupported, which is why
  this backend exists. The Chrome extension in `micro-dac-extension/` reads the
  preset from that page and posts it here instead.

## Note for `v2/`

`v2/server.py` talks to hidapi from request threads. On macOS `hid.enumerate()`
is not thread safe and crashes the process under concurrent requests; `v3` runs
every HID call on one dedicated worker thread. The same fix applies to v2 if it
ever gets stressed, but it was left untouched here.
