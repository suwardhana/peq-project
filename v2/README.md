# RU3 v2 — real-protocol controller

Before connecting any UI, v2 proves DAC communication with the protocol
captured from the official Android app (see `PROTOCOL.md` and `captures/`).
The v1 "BUXX/CRC32" framing was disproved: the real frame is
`4B / opcode / cmd / len` with no checksum.

Run from the project root with the project venv (DAC plugged into this PC):

```powershell
.\.venv\Scripts\python.exe v2/dac.py                  # read full state
.\.venv\Scripts\python.exe v2/dac.py --set-volume 85  # set + read-back verify
.\.venv\Scripts\python.exe v2/dac.py --dump-peq       # read 10 PEQ bands
.\.venv\Scripts\python.exe v2/dac.py --set-peq p.json  # apply preset, verify
.\.venv\Scripts\python.exe v2/test_dac.py             # unit tests (no DAC needed)
```

`p.json`: `{"bands": [{"freq": 32, "q": 0.71, "gain": 0.0, "type": "PEAK"},
... x10]}`. Types: BYPASS/LSHELF/PEAK/HSHELF/LPF/HPF (shelf/pass blobs
unverified, see `PROTOCOL.md`).

Reads: volume, gain, output, work mode, EQ preset, UAC, PCM filter,
firmware, plus raw bytes of unknown commands. Writes: simple one-byte
settings with GET read-back verification, plus full 10-band PEQ presets
and the separate USER_GEQ bank (RBJ @ 96 kHz, app-compatible to +-1 LSB
for PEAK).

Raw USB transactions are logged to `v2/logs/`. `null` means that query got
no response; `verified:false` means the read-back did not match.

## Web UI

Stdlib-only server + static page (`v2/web/`), no CDN/framework:

```powershell
.\.venv\Scripts\python.exe v2/test_server.py  # API tests (no DAC needed)
.\.venv\Scripts\python.exe v2/test_autoeq.py  # AutoEq parser tests (needs node)
.\.venv\Scripts\python.exe v2/server.py       # → http://127.0.0.1:8765
```

Features: device panel (volume, gain, output, work mode, EQ, UAC with
reconnect poll, PCM filter), and a 10-band PEQ editor with a draggable
log-frequency response graph (RBJ @ 96 kHz, same math as `dac.py`),
keyboard support, auto-save with per-band verification, and an offline
banner with auto-reconnect when the DAC is unplugged.

### Graphic EQ (USER_GEQ)

The **Graphic EQ** tab controls the real USER_GEQ bank (preset **8**),
independently of USER_PEQ (preset **9**). It has ten vertical gain sliders:
**32, 64, 125, 250, 500, 1k, 2k, 4k, 8k, 16k Hz**. Frequency, Q (0.71),
and PEAK type are fixed; gain is adjustable from −12 to +12 dB in 0.1 dB
steps. Numeric inputs, arrow keys, double-click to zero, and Reset flat are
supported. Edits save automatically after 500 ms, with read-back verification
and selective retries for dropped band writes.

Switching editor tabs only reads that bank. Select **GEQ** / **PEQ** in the
device panel, or **Use Graphic** / **Use Parametric**, to activate it. Editing
an inactive bank saves its settings; the warning explains why it is silent.
GEQ edits never write the PEQ bank. AutoEq import remains in the PEQ editor.

On macOS, with RU3 connected to the Mac:

```sh
./run-v2.sh
# Or: .venv-mac/bin/python v2/server.py
# Open http://127.0.0.1:8765
```

API:

```text
GET  /api/geq      → {preset:8, frequencies:[...], q:0.71, bands:[...]}
POST /api/geq     {"gains":[0,0,0,0,0,0,0,0,0,1]}
                  → {preset:8, bands:[{band:0, verified:true}, ...]}
POST /api/setting {"key":"eq", "value":8}  # activate and commit
```

POST `/api/geq` requires exactly ten finite numeric gains in −12..+12 dB;
it returns 400 for invalid input, 500 if any band still fails verification
after three attempts, or 503 for a transport/device failure. Success verifies
stored bytes, not the audible response. Reads and saves do not select a mode.

The GEQ protocol is backed by `captures/geq_custom.txt`, captured from Cayin
v1.1.3 + RU3 firmware V1.0.3 on 2026-11-04. See `PROTOCOL.md` for evidence
and verification limits. To record another OEM session without clearing logs
or issuing USB commands:

```sh
python3 v2/capture_geq.py --serial IP:PORT --label geq_slider
# Operate the phone app, then Ctrl+C. Raw log + parsed JSON: v2/logs/geq/
python3 v2/capture_geq.py --input v2/captures/geq_custom.txt
.venv-mac/bin/python -m unittest discover -s v2 -p 'test_*.py'
```

PEQ panel has an AutoEq import box: paste `ParametricEQ.txt` (or pick the
file) and it maps PK/LS/HS/LP/HP onto the 10 bands, folds preamp into the
gains (DAC has no preamp control), clamps to device limits with a warning,
then saves through the normal verified path.
