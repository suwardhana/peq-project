# Hangout / Squiglink PEQ → CrinEar Protocol Micro

Chrome/Edge extension that adds an **Apply PEQ to Protocol Micro** panel to
`eq.hangout.audio` (and `squig.link`, which shares the same page structure).

The extension talks to the DAC itself over **WebHID** — no backend, no Python.

- **Click the toolbar icon** → a full PEQ editor opens (graph, drag bands, AutoEq
  import, pregain). Press **Connect** once and pick *Protocol Micro* in Chrome's
  list; Chrome remembers the permission.
- **On eq.hangout.audio / squig.link** the panel reads the active EQ rows,
  converts them to the device's eight bands and writes them straight to the DAC.
  (If the DAC was never authorised, open the editor and press Connect first.)

The device has **8 bands**. When the page has more rows ticked than that, the
panel shows the count in amber (`10/8`), disables the apply button, and offers a
small **Uncheck N weakest** button: it unticks the rows with the smallest
absolute gain — the ones that shape the curve least — until the rest fits. Hover
it to see exactly which rows will go.

## Install

1. Open `chrome://extensions` (or `edge://extensions`).
2. Enable **Developer mode** → **Load unpacked** → select `micro-dac-extension`.
3. Linux only: allow your user to open the device, once —
   `echo 'KERNEL=="hidraw*", ATTRS{idVendor}=="3302", ATTRS{idProduct}=="c20f", TAG+="uaccess"' | sudo tee /etc/udev/rules.d/70-protocol-micro.rules && sudo udevadm control --reload && sudo udevadm trigger`, then replug.

## Use

1. Open <https://eq.hangout.audio/> with an EQ loaded (or paste the share URL).
2. Switch to **Advanced EQ** so the filter rows exist.
3. The panel sits under **Device PEQ** and shows `n/8` plus the preamp it read.
4. Click **Apply PEQ to Protocol Micro** and wait for the read-back result.

A successful run reports `Applied and verified: 8/8 bands.` If the DAC is not
authorised or not plugged in you get an explicit error.

## What it reads

| Page element | Used for |
| ------------ | -------- |
| `input[name="freq"]` (+ `.filter` row) | band frequency |
| `input[name="gain"]` | band gain |
| `input[name="q"]` | band Q |
| `select[name="type"]` | PK / LSQ / HSQ / LSC / HSC / LP / HP |
| `input[name="enabled"]` | unticked rows are skipped |
| `.preamp-disp` | `Pre-amp: -3.2 dB` → device pregain, rounded to whole dB |
| the filter curve itself | fallback preamp when the page prints none (squig.link) |

Rows left at `0 Hz / 0 dB` are treated as unused placeholders, not as an error.
Types are mapped to the device names `PEAK`, `LSHELF`, `HSHELF`, `LPF`, `HPF`;
unused bands are padded with flat `PEAK` because the device has no bypass type.

## Pregain

`eq.hangout.audio` prints the preamp on the page, so that value is used as-is.
`squig.link` only writes it into the exported `ParametricEQ.txt`, so the panel
derives it instead: the highest point of the summed filter response, negated —
exactly what squig's own `Equalizer.calc_preamp` computes. The panel marks a
derived value with **(auto)** and shows the precise figure in its tooltip.

The DAC's pregain register is a whole decibel, so the derived value is rounded.

## Limits

Values outside the device limits (20–20000 Hz, Q 0.1–10, gain ±12 dB) are
clamped, and the panel names the first clamped band. The gain limit matters for
AutoEq presets that boost more than 10 dB — the firmware stores larger values
without complaint, but the vendor config for this chip family documents ±10 dB.

## Development

```bash
node --test ./micro-dac-extension/test/peq-core.test.js
```

`micro.js` is the WebHID port of `v3/micro.py` (checked against the
hardware-captured coefficient words). `peq-core.js` is dependency-free and runs both in the browser and in Node, so
the conversion logic is tested without a DAC or a browser.
