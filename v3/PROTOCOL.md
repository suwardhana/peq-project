# CrinEar Protocol Micro — HID protocol (verified on hardware)

Device: **CrinEar Protocol Micro**, USB product string `Protocol Micro`,
`idVendor 0x3302` / `idProduct 0xC20F`, firmware reported as `0.2`.

Everything below was verified on the physical unit on 2026-11-01 by writing
values and reading them back. Where a value is inferred rather than observed it
is marked **unverified**.

## Provenance

The vendor points users at <https://eq.hangout.audio/> for PEQ. That site ships
a `devicePEQ` plugin whose `walkplayHidHandler.js` documents the protocol family
this dongle belongs to (Walkplay, vendor id `0x3302`, "SchemeNo11"). This unit is
currently **not** in the site's device table — linking it answers *"Sorry, this
USB device is not currently supported"* — so the implementation here was derived
from the handler source plus direct read/write experiments against the hardware.

## Transport

- USB HID, vendor usage page `0xFF01`, one interface.
- Report descriptor exposes report id **`0x4B`** with a **63-byte** data payload
  (64 bytes including the report id), plus an unused `0x54` pair.
- `hidapi` wants the report id as the first byte of the buffer; the payload must
  be padded to exactly 63 bytes after it.
- Frame (no checksum):

| Byte | Meaning |
| ---- | ------- |
| 0 | report id `0x4B` |
| 1 | opcode: `0x80` = READ, `0x01` = WRITE |
| 2 | command |
| 3 | length byte |
| 4.. | payload |

The length byte does **not** always equal the payload size — a band record
declares `0x18` while carrying 34 bytes, and the apply marker declares `0x04`
while carrying 5. Send it verbatim as documented below.

## Commands

| Cmd | Dir | Payload | Meaning |
| --- | --- | --- | --- |
| `0x01` | W | `[]` | flash: persist the working EQ to the device |
| `0x01` | W | `[1, slot]` / `[0, slot]` | enable / disable EQ slot (reference only, **unverified** here) |
| `0x02` | R | `[]` | mic gain (present on the family; reports 0 on this unit) |
| `0x03` | R/W | `[]` / `[0x00, gain]` | **pregain**, signed int8 dB; read value at wire byte 5 |
| `0x05` | W | `[]` | unlock/stage step 1, sent before a band burst |
| `0x09` | R | `[0x00, band]` | read band record; band index at wire byte 5 |
| `0x09` | W | band record (below) | write one band |
| `0x0A` | W | `[0x00,0x00,0xFF,0xFF,0x00]` | apply marker, closes the burst |
| `0x0C` | R | `[]` | ASCII firmware string at wire byte 4 (`"0.2"`) |
| `0x17` | W | `[]` | unlock/stage step 2 |

## Band record

Write packet (37 bytes, then padded to 64):

| Wire offset | Size | Meaning |
| ----------- | ---- | ------- |
| 3 | 1 | length byte, always `0x18` |
| 4 | 1 | `0x00` |
| 5 | 1 | band index 0..7 |
| 6..7 | 2 | zero |
| 8..28 | 20 | coefficient blob, 5 x int32 LE (Q1.30) |
| 28..30 | 2 | frequency Hz, u16 LE |
| 30..32 | 2 | Q x 256, u16 LE |
| 32..34 | 2 | gain dB x 256, i16 LE |
| 34 | 1 | type: 1 = LSHELF, 2 = PEAK, 3 = HSHELF, 4 = LPF, 5 = HPF |
| 35 | 1 | zero |
| 36 | 1 | slot id (device reports `101`) |
| 37 | 1 | terminator `0x00` |

Read response is the same layout, echoed back at the same offsets, plus
`0x4B 0x80 0x09` in bytes 0..2. All five types round-trip unchanged, so the
device stores the type byte verbatim. Reading band index >= 8 returns
uninitialised memory — never read past the eighth band.

## Coefficient blob

Five little-endian int32 words, order `[b0, b1, b2, -a1, -a2]`, each
`round(value * 2**30)`.

The biquad is the RBJ **peak** cookbook at **fs = 96000 Hz**, evaluated with the
caller's exact floats (not the Q8.8 values that get stored):

```python
A  = sqrt(10 ** (gain_db / 20))
w  = 2 * pi * freq / 96000
s  = sin(w) / (2 * Q)
d4 = s * A            # alpha * A
d5 = s / A            # alpha / A
d6 = 1 + d5           # a0
b0 = (1 + d4) / d6    b1 = (-2*cos(w)) / d6    b2 = (1 - d4) / d6
a1 = (-2*cos(w)) / d6 a2 = (1 - d5) / d6
```

Verified: all eight bands of a real preset reproduce the stored words
byte-for-byte (see `test_micro.py::CAPTURED`).

Note the scale is **2^30**, not the 2^31 used by the Cayin RU3 — the two
protocols look alike but are not interchangeable.

The reference implementation computes this peak blob for *every* filter type,
including shelves and pass filters, and separately sets the type byte. Whether
the DSP derives shelves from type+freq+Q+gain or from the blob was not
distinguished by ear on this unit. We reproduce the reference behaviour exactly.

## Write sequence

```
WRITE 0x05 []                                   # unlock 1
WRITE 0x17 []                                   # unlock 2
WRITE 0x09 <band 0 record>
...
WRITE 0x09 <band 7 record>                      # ~30 ms apart
WRITE 0x0A [00 00 FF FF 00]                     # apply
WRITE 0x01 []                                   # flash
[~0.9 s settle, then read every band back]
```

Writing all eight bands in one burst was reliable. A single-band edit also took
effect in our tests, but the site's own handler always writes the whole set, so
that is what this backend does.

## Pregain

`pregain` is a single signed byte, whole dB. Read with `0x03` and take wire byte
5; write `[0x00, value]` behind command `0x03`. Verified: writing `-3` reads back
`-3`, writing `0` reads back `0`.

The reference for related devices applies a fixed `-5 dB` hardware buffer and
only writes `min(0, preamp - (-5))`. On this unit the register behaved as a plain
absolute pregain (0 in, 0 out), so no buffer is applied.

## Limits

The firmware performs **no validation**: values well outside the documented range
were accepted and read back unchanged (gain +-15 dB, Q 20, 30 kHz). Software
therefore enforces, matching the reference config for this scheme:

| Parameter | Range |
| --------- | ----- |
| bands | 8 |
| freq | 20..20000 Hz, integer |
| Q | 0.1..10 (Q8.8) |
| gain | -12..+12 dB (Q8.8); +12 dB confirmed audible over +10 dB |
| pregain | -12..0 dB, integer |

## BYPASS

The device has no bypass id. Software sends BYPASS as a flat PEAK record
(gain 0, type id 2) and reads any flat PEAK/LSHELF/HSHELF record back as
BYPASS. LPF/HPF at 0 dB keep their names because they still filter.

## Still unverified

- Whether the EQ slot must be enabled with `[WRITE 0x01, 1, 101]` before a push
  is audible. Our unit was already enabled; we do not send the enable packet so
  we cannot disable anything by accident.
- The sound of shelves/pass filters versus the peak blob (needs ears + a
  measurement rig).
- Whether `0x02` (mic gain) is meaningful on this model — it reads 0.
- Slot semantics beyond the single `101` "Custom" the device reports.
