# Cayin RU3 — real HID protocol (captured from the official Android app)

Evidence: `v2/captures/*.txt` — USB packet logs (`UsbHidManager` tag) recorded
via `adb logcat` while operating the official Cayin app (v1.1.3) against the
DAC on 2026-10-17, with USER_GEQ capture added on 2026-11-04. Every command below was observed on the wire; write
commands were each verified by tapping the control in the app and reading the
result back. The v1 "BUXX/CRC32" theory is wrong for device control (that
framing exists in the APK's Java transport class but the app never sends it
to the RU3).

## Transport

- USB HID interface 0, interrupt OUT 0x05 / IN 0x86, 64-byte reports.
- Report ID **75 (0x4B)**. Report descriptor also exposes ID 1 and ID 3, unused.
- Frame, 64 bytes, zero-padded, **no checksum**:

| Byte | Meaning |
| ---- | ------- |
| 0 | Report ID `0x4B` |
| 1 | Opcode: `0x80` = GET, `0x01` = SET |
| 2 | Command ID (one byte) |
| 3 | Payload length N |
| 4..4+N | Payload |

- GET response: `[0x4B, 0x80, cmd, len, data...]`; len echoes the request
  length (`0x00` for simple queries, `0x21` for band records). Data at offset 4.
- Simple SETs get **no response**. Verify with a GET read-back.
- The DAC drops back-to-back SETs: pace writes ~25 ms apart (and ~150 ms
  settle before read-back), like the app does. Otherwise every other write
  is silently lost.
- Multi-byte integers are little-endian.

## Command map (all values verified unless noted)

| Cmd | Get | Set | Meaning |
| --- | --- | --- | ------- |
| `0x01` | — | len 0 | Commit/apply (sent after EQ preset and PEQ writes) |
| `0x03` | `00` | `00`/`01` | Gain: 0 = Low, 1 = High |
| `0x09` | 33-byte record | 33-byte record | User EQ band 0..9; byte 0 selects bank 8 (GEQ) / 9 (PEQ) |
| `0x0A` | — | `08 00 00 00` GEQ / `09 00 FF FF` PEQ single edit / `09 00 00 00` PEQ full apply | EQ apply marker |
| `0x0C` | `"V1.0.3"` | — | Firmware version string |
| `0x11` | `00` | `00`/`01` | PCM filter: 0 = Minimum Phase, 1 = Linear phase trace rapid roll-off (IDs 2-6 presumed in picker order, unverified) |
| `0x1A` | `00` | `00`/`01`/`08`/`09` | EQ preset: 0 = OFF, 8 = Custom GEQ, 9 = Parametric (1 observed when enabling from OFF, exact preset unverified) |
| `0x1E` | `01` | `00`/`01` | UAC: 0 = UAC1 (PID `0x003A`), 1 = UAC2 (PID `0x003B`); device re-enumerates |
| `0x21` | `01` | `00`/`01` | Work mode: 0 = STD, 1 = HYP |
| `0x22` | `00` | `00`/`01` | Output: 0 = PO, 1 = LO |
| `0x23` | `5A` (90) | 0..100 | Volume |
| `0x16` | `00` | — | Unknown (reads zero) |
| `0x1F` | `05` | — | Unknown (reads 5) |
| `0x20` | `06` | — | Unknown (reads 6) |
| `0x24` | `00` | — | Unknown (reads zero) |
| `0x14`, `0x25` | no response | — | Sent by the app during sync, DAC never answers |

"Get" column shows the value observed with device state: vol 90, gain Low,
PO, EQ off, UAC2, HYP, filter Minimum Phase, fw V1.0.3.

## PEQ band record (33-byte payload of cmd `0x09`)

| Offset | Size | Meaning |
| ------ | ---- | ------- |
| 0 | 1 | `0x09` (USER_PEQ) or `0x08` (USER_GEQ) |
| 1 | 1 | Band index 0..9 |
| 2..4 | 2 | Zero |
| 4..8 | 4 | Coefficient word (flat = `FF FF FF 7F`; app-computed) |
| 8..24 | 16 | Coefficient blob, two 8-byte halves (app-computed biquads) |
| 24..26 | 2 | Frequency Hz, u16 LE (32, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000) |
| 26..28 | 2 | Q x 256, u16 LE (Q8.8; default 182 = 0.71) |
| 28..30 | 2 | Gain dB x 256, i16 LE (Q8.8 signed; +0.1 dB step = 26) |
| 30 | 1 | Type: 1 = LSHELF, 2 = PEAK, 3 = HSHELF (0/4/5 unseen: presumably Bypass/LPF/HPF) |
| 31 | 1 | Zero |
| 32 | 1 | `0x01` (enabled marker, always observed as 1) |

Band query payload (GET `0x09`, len `0x21`): the record template with the
coefficient/plain fields zeroed except `[4:8] = FF FF FF 7F` and
`[26:33] = C0 00 00 00 00 00 01`; see `BANDQ_TX` in the captures.

Observed flows:
- Open Parametric editor: `SET 0x1A=09`, commit, `GET 0x1A`, ten band
  queries, ten band rewrites, `SET 0x0A = 09 00 00 00`, commit.
- Single edit: band write, `SET 0x0A = 09 00 FF FF`, commit (~2 s debounce).
- App reset: ten flat-PEAK writes, `SET 0x0A = 09 00 00 00`, commit.

## USER_GEQ (captured 2026-11-04)

`captures/geq_custom.txt` is an unmodified UTF-8 `UsbHidManager` trace from
Cayin Android v1.1.3 (39), RU3 (U2) firmware V1.0.3. It contains positive,
negative, and flat slider writes, queries of both independent banks, and
selection read-backs for preset 8 and 9. Static APK inspection found
`_writeGeqCustomToDevice` and `_ensureGeqCustomBaseBands`; the USB trace is
the evidence for the packet format.

Trace SHA-256: `a9d1fd65f5dc934020f68ace3673b5d1b1e2407f469fbfcf1c709d402e460a91`.

GEQ uses the same 33-byte band layout, query template, and 96 kHz coefficient
encoding as PEQ, with these fixed values:

- Bank/preset byte **8** (USER_GEQ), independently queryable from bank 9.
- Frequencies **32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000 Hz**;
  the second band is **64**, not the historical PEQ default of 63.
- Type **2 (PEAK)**, enabled **1**, Q computed from **0.71**.
  The stored Q8.8 field is `B6 00` (182/256); recomputing coefficients from
  that rounded Q instead of exact 0.71 does not reproduce the GEQ blobs.
- Gain uses signed Q8.8; +0.5 = `80 00`, −0.5 = `80 FF`.

Observed OEM slider sequence:

```text
SET 0x09 len 0x21  [08, band, ..., coefficients, freq, Q, gain, 02, 00, 01]
SET 0x0A len 0x04  [08, 00, 00, 00]
SET 0x01 len 0x00  []                    # ~2-second app debounce
```

Selecting Custom sends `SET 0x1A [08]`, commit, `GET 0x1A` returning 8,
then ten bank-8 queries. Selecting Parametric returns 9 and queries bank 9,
whose frequencies/gains differ. The final queries in the trace confirm the
original GEQ gains restored to `[0,0,0,0,0,0,0,0,0,1]`, with preset 8 active.

v2 batches all ten GEQ records with paced writes, applies bank 8, commits,
then verifies every stored record byte-for-byte. Only failed bands are
rewritten, up to three passes. Reading/saving does not send `0x1A`; activation
is a separate setting request. Tests compare OEM positive/negative/flat
coefficients within ±1 LSB and exercise bank isolation, dropped packets,
validation, and HTTP behavior. Browser QA uses simulated device responses;
it does not prove hardware storage or audibility. The original direct-PC
verification below predates GEQ.

## Verification status (2026-10-17, DAC on PC)

- All GETs answer and decode correctly (vol 90, LOW, PO, HYP, OFF, UAC2,
  Minimum Phase, V1.0.3 — all match the OLED).
- SET volume verified by GET read-back (90 -> 85).
- PEQ band write + restore verified byte-identical by read-back.
- Other SETs are packet-identical to app captures (effect verified via the
  app on the phone, not yet replayed from this PC).

## Coefficient blob `[4:24]` (cracked 2026-10-18)

Five little-endian words `[b0, b1+2, b2, a1+2, a2] x 2^31`, rounded:

- RBJ Audio-EQ-Cookbook biquads at **fs = 96000 Hz**, float64, normalized.
- PEAK verified against 26 app-computed blobs (flat/gain/Q/freq ladders
  in `captures/`): every word matches within **+-1 LSB** (inaudible).
- The app computes from exact state floats: Q/g as loaded `field/256`
  plus float64-tapped steps. v2 uses the caller's exact floats instead.
- The DAC stores records verbatim (zero-blob experiment), so the blob fully
  determines the sound. Read-back verifies storage, not audibility.
- LSHELF/HSHELF/LPF/HPF use the same cookbook/SR/word layout. LSHELF is
  sound-verified (blind +8 dB bass-shelf test passed, no artifacts);
  bit-parity vs the app still needs one nonzero-gain capture per type.
  BYPASS writes a flat-PEAK blob (safe either way).

## Open questions

- Shelf/pass blob verification (one capture each at nonzero gain).
- PEQ writes have not been sound-checked yet (needs DAC on this PC + ears).
- Filter IDs 2-6, EQ preset IDs 1-7, PEQ types 0/4/5: presumed, unverified.
- Commands `0x16`, `0x1F`, `0x20`, `0x24`, `0x14`, `0x25`: unknown purpose.
