# Squiglink PEQ to Cayin RU3

Chrome/Edge extension that adds **Apply PEQ to DAC** to
`squig.link` and all of its subdomains.

The extension reads the active filter rows directly from Squiglink, converts
PK/LSQ/HSQ to the RU3 PEQ types, pads unused bands with `BYPASS`, then sends
the resulting 10-band preset to the local v2 backend at:

```text
POST http://127.0.0.1:8765/api/peq
```

## Install

1. Start the backend by double-clicking `run-v2.bat` in the project root.
2. Open `chrome://extensions` (or `edge://extensions`).
3. Enable **Developer mode**.
4. Choose **Load unpacked**.
5. Select this folder: `squiglink-dac-extension`.

## Use

1. Open a Squiglink page such as `https://aftersound.squig.link/`.
2. Select or AutoEQ a parametric EQ with no more than 10 enabled bands.
3. Click **Apply PEQ to DAC**.
4. Wait for the read-back result. A successful run reports `Applied and verified`.

The button stays disabled while no valid PEQ values are present. It becomes
blue and clickable as soon as at least one band has a valid frequency value.

If the backend is not running, the button shows a clear error. Start
`run-v2.bat` and click again.

## Development

Run the parser tests without a DAC or browser:

```powershell
node --test .\squiglink-dac-extension\test\peq-core.test.js
```
