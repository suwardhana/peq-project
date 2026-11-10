# Cayin RU3 (ES9069Q) — Hardware Protocol & Reverse Engineering Specification
**Target Device**: Cayin RU3 Dual DAC (ESS Sabre ES9069Q) • Firmware Target: v1.0.3+  
**Operating Systems**: macOS / Linux / Android / Windows  
**Document Purpose**: Complete technical specification and reference manual for direct hardware communication with Cayin RU3 DAC registers (OLED Display Volume, Gain Rails, Power Modes, ESS Digital Filters, and 10-Band Parametric EQ).

---

## 1. Hardware Topology & USB Descriptors

| Property | Value | Description |
| :--- | :--- | :--- |
| **Vendor ID (VID)** | `0x2D87` | Cayin Audio Co., Ltd. |
| **Product ID (PID - U2 Mode)** | `0x003B` | UAC 2.0 Mode (High-Resolution PCM/DSD) |
| **Product ID (PID - U1 Mode)** | `0x003A` | UAC 1.0 Mode (Legacy / Gaming / Switch) |
| **Device Class** | `0xEF` (Miscellaneous) | SubClass `0x02`, Protocol `0x01` |
| **DAC Architecture** | Dual ESS ES9069Q | HyperStream IV 32-Bit DAC |
| **Amplifier Section** | Dual RT6863 Op-Amps | 3.5mm Single-Ended + 4.4mm Balanced |

### USB Interface & Endpoint Architecture
```text
Cayin RU3 USB Configuration 1 (100 mA)
├── Interface 0: Human Interface Device (HID) [Class 0x03, SubClass 0x00]
│   ├── Endpoint 0x86: Interrupt IN  (64 Bytes, Interval 8ms) -> Telemetry / Responses
│   └── Endpoint 0x05: Interrupt OUT (64 Bytes, Interval 8ms) -> Control Packets / Registers
├── Interface 1: Audio Control (UAC2) [Class 0x01, SubClass 0x01]
└── Interface 2: Audio Streaming (UAC2) [Class 0x01, SubClass 0x02]
    ├── Endpoint 0x07: Isochronous OUT (776 Bytes, Interval 1ms) -> PCM Audio Stream
    └── Endpoint 0x83: Isochronous IN  (4 Bytes, Interval 4ms)   -> Audio Feedback Clock
```

---

## 2. Binary Framing Protocol (`BUXX` Frame)

All control transmissions to the Cayin RU3 hardware use the binary framing protocol extracted from `libapp.so` (`package:dmp_control/core/utils/ru3_usb_utils.dart`).

### Packet Framing Layout
```text
+-------------------------------------------------------------------------------+
|                                HEADER (14 Bytes)                              |
+---------------+---------------+---------------+---------------+---------------+
| Magic (4B)    | Cmd ID (2B)   | Seq (1B)      | Flag (1B)     | Length (2B)   |
| 0x58585542    | uint16 LE     | uint8         | 0x00          | uint16 LE     |
+---------------+---------------+---------------+---------------+---------------+
| Header CRC32 (4 Bytes) - IEEE 802.3 over first 10 Bytes (Little Endian)       |
+-------------------------------------------------------------------------------+
|                                PAYLOAD (Length Bytes)                         |
+-------------------------------------------------------------------------------+
| Payload Data (0 to N Bytes)                                                   |
+-------------------------------------------------------------------------------+
| Payload CRC32 (4 Bytes, omitted if Length == 0) - IEEE 802.3 over Payload     |
+-------------------------------------------------------------------------------+
```

### 14-Byte Header Specification
| Byte Offset | Type | Field Name | Description | Example |
| :---: | :---: | :--- | :--- | :--- |
| `0..3` | `uint32` | `Magic` | ASCII "BUXX" (`0x58585542` in Little Endian: `42 55 58 58`) | `0x58585542` |
| `4..5` | `uint16` | `CmdID` | Command code (Little Endian) | `0x0002` (Set Volume) |
| `6` | `uint8` | `Seq` | Monotonically incrementing sequence counter (`0..255`) | `0x01` |
| `7` | `uint8` | `Flag` | Status / Frame flag (`0x00` default) | `0x00` |
| `8..9` | `uint16` | `Length` | Length of payload data in bytes (Little Endian) | `0x0004` (4 Bytes) |
| `10..13`| `uint32` | `HeadCRC` | IEEE 802.3 CRC32 over bytes `0..9` (Little Endian) | `0x903FE8EC` |

---

## 3. Command Codes & Hardware Register Map

| Command Code | Identifier | Direction | Payload Size | Payload Value & Specification |
| :---: | :--- | :---: | :---: | :--- |
| `0x1001` | `CMD_GET_DEV_INFO` | Host -> DAC | 0 Bytes | Queries firmware version, model string, and hardware features. |
| `0x1002` | `CMD_GET_VOLUME` | Host -> DAC | 0 Bytes | Queries physical OLED Hardware Volume (`0` to `100`). |
| `0x0002` | `CMD_SET_VOLUME` | Host -> DAC | 1 or 4 Bytes | Hardware Volume: `uint8` or `uint32 LE` (`0` to `100`). |
| `0x0003` | `CMD_SET_GAIN` | Host -> DAC | 1 Byte | `0x00` = Low Gain (0dB IEM)<br>`0x01` = High Gain (+12dB Headroom) |
| `0x0004` | `CMD_SET_WORK_MODE` | Host -> DAC | 1 Byte | `0x00` = STD (Standard Power)<br>`0x01` = HYP (Hyper Turbo Rail Voltage) |
| `0x0005` | `CMD_SET_OUT_MODE` | Host -> DAC | 1 Byte | `0x00` = PO (Headphone 3.5/4.4 with volume)<br>`0x01` = LO (Line-Level fixed 2.0V/4.0V) |
| `0x0006` | `CMD_SET_PCM_FILTER` | Host -> DAC | 1 Byte | `1..7` ESS ES9069Q Digital Filters (see map below). |
| `0x0007` | `CMD_SET_SCREEN_OFF` | Host -> DAC | 1 Byte | OLED Sleep Timeout in seconds (`0`=Always on, `15`, `30`, `60`, `120`). |
| `0x0008` | `CMD_SET_BALANCE` | Host -> DAC | 1 Byte | Signed byte (`-10` to `+10` dB channel offset). |
| `0x0100` | `CMD_SET_PEQ_BANDS` | Host -> DAC | 80 Bytes | 10 Parametric EQ Bands (8 Bytes per band, see layout below). |
| `0x0101` | `CMD_GET_PEQ_BANDS` | Host -> DAC | 0 Bytes | Queries 10-Band PEQ registers from DAC memory. |
| `0x0102` | `CMD_SET_PEQ_ENABLE` | Host -> DAC | 1 Byte | `0x01` = Master PEQ Active<br>`0x00` = Master PEQ Bypassed |

---

## 4. 10-Band Parametric EQ (PEQ) Register Layout

The PEQ configuration payload consists of exactly **80 Bytes** (10 bands x 8 bytes per band).

### 8-Byte Band Binary Descriptor
```text
+-----------------------+-----------------------+-----------------------+-----------+-----------+
| Frequency (Hz)        | Gain (dB * 256)       | Q-Factor (* 100)      | Type      | Enabled   |
| uint16 LE (2 Bytes)   | int16 LE (2 Bytes)    | uint16 LE (2 Bytes)   | uint8 (1B)| uint8 (1B)|
+-----------------------+-----------------------+-----------------------+-----------+-----------+
```

| Offset | Field | Type | Scale / Range | Description |
| :---: | :--- | :---: | :--- | :--- |
| `+0..1` | `Frequency` | `uint16 LE` | `20` to `20000` Hz | Center / Cutoff frequency |
| `+2..3` | `Gain` | `int16 LE` | `Gain_dB * 256` (Q8.8 Fixed-Point) | Range: `-12.0` to `+12.0` dB (`-3072` to `+3072`) |
| `+4..5` | `Q-Factor` | `uint16 LE` | `Q * 100` | Range: `0.10` to `10.00` (`10` to `1000`) |
| `+6` | `FilterType` | `uint8` | `0..7` | Filter algorithm type (see below) |
| `+7` | `Enabled` | `uint8` | `0` or `1` | `1` = Active, `0` = Bypassed |

### Filter Type Identifier Table
* `0` = **PEAK (Bell / Parametric)**
* `1` = **LOW_SHELF**
* `2` = **HIGH_SHELF**
* `3` = **LOW_PASS (LPF)**
* `4` = **HIGH_PASS (HPF)**
* `5` = **BAND_PASS**
* `6` = **NOTCH**
* `7` = **ALL_PASS**

### Standard 10-Band Frequency Distribution
`[31 Hz, 63 Hz, 125 Hz, 250 Hz, 500 Hz, 1000 Hz, 2000 Hz, 4000 Hz, 8000 Hz, 16000 Hz]`

---

## 5. ESS ES9069Q PCM Digital Filters (`CMD_SET_PCM_FILTER`)

| Filter ID | Filter Name | Characteristics |
| :---: | :--- | :--- |
| `1` | **Linear Phase Rapid Roll-Off (Low Ripple)** | Studio reference default; ultra-low ripple, pristine linear phase. |
| `2` | **Linear Phase Rapid Roll-Off** | Sharp high-frequency cutoff, crisp transient edges. |
| `3` | **Linear Phase Slow Roll-Off** | Gentle high-frequency decay, natural acoustic response. |
| `4` | **Minimum Phase Rapid Roll-Off (Low Dispersion)** | Minimum pre-ringing; punchy percussive impact. |
| `5` | **Minimum Phase Rapid Roll-Off** | Fast decay, zero pre-echo, forward dynamic presentation. |
| `6` | **Minimum Phase Slow Roll-Off** | Warm, musical timbre with smooth acoustic decay. |
| `7` | **Minimum Phase** | Organic vintage analogue warmth with gentle roll-off. |

---

## 6. Checksum Algorithms

### IEEE 802.3 CRC32 Implementation (Python)
```python
crc32_table = []
for i in range(256):
    c = i
    for _ in range(8):
        c = (0xEDB88320 ^ (c >> 1)) if (c & 1) else (c >> 1)
    crc32_table.append(c)

def calc_crc32(data: bytes) -> int:
    crc = 0xFFFFFFFF
    for b in data:
        crc = (crc >> 8) ^ crc32_table[(crc ^ b) & 0xFF]
    return (crc ^ 0xFFFFFFFF) & 0xFFFFFFFF
```

---

## 7. macOS Direct Hardware Controller (`macos_ru3_controller.py`)

On macOS, `AppleUSBAudio` allows non-exclusive access to HID Interrupt Endpoints. You can communicate directly via Python `hidapi` or WebHID without kernel claim issues.

```python
import hid
import struct
import time

CAYIN_VID = 0x2D87
CAYIN_PID_U2 = 0x003B
REPORT_ID = 75

crc32_table = []
for i in range(256):
    c = i
    for _ in range(8):
        c = (0xEDB88320 ^ (c >> 1)) if (c & 1) else (c >> 1)
    crc32_table.append(c)

def calc_crc32(data: bytes) -> int:
    crc = 0xFFFFFFFF
    for b in data:
        crc = (crc >> 8) ^ crc32_table[(crc ^ b) & 0xFF]
    return (crc ^ 0xFFFFFFFF) & 0xFFFFFFFF

class CayinRU3MacOS:
    def __init__(self):
        self.dev = hid.device()
        self.dev.open(CAYIN_VID, CAYIN_PID_U2)
        self.dev.set_nonblocking(1)
        self.seq = 0
        print(f"Connected to {self.dev.get_product_string()} on macOS!")

    def _build_packet(self, cmd: int, payload: bytes = b'') -> bytes:
        magic = b'BUXX'
        seq = (self.seq) & 0xFF
        self.seq = (self.seq + 1) & 0xFF
        flag = 0
        length = len(payload)
        
        # 10-byte header
        head_raw = magic + struct.pack('<HBBH', cmd, seq, flag, length)
        head_crc = calc_crc32(head_raw)
        pkt = head_raw + struct.pack('<I', head_crc)
        
        if length > 0:
            body_crc = calc_crc32(payload)
            pkt += payload + struct.pack('<I', body_crc)
        return pkt

    def send_cmd(self, cmd: int, payload: bytes = b''):
        pkt = self._build_packet(cmd, payload)
        buf = bytes([REPORT_ID]) + pkt + bytes(max(0, 64 - len(pkt) - 1))
        self.dev.write(buf[:64])
        time.sleep(0.02)
        resp = self.dev.read(64)
        return resp

    def set_volume(self, val: int):
        """Sets hardware volume on OLED display (0 to 100)."""
        return self.send_cmd(0x0002, struct.pack('<I', val))

    def set_gain(self, high_gain: bool):
        """False = Low Gain, True = High Gain."""
        return self.send_cmd(0x0003, bytes([1 if high_gain else 0]))

    def set_work_mode(self, hyper_mode: bool):
        """False = Standard STD, True = Hyper Turbo HYP."""
        return self.send_cmd(0x0004, bytes([1 if hyper_mode else 0]))

    def set_pcm_filter(self, filter_num: int):
        """1 to 7 ESS ES9069Q Digital Filter."""
        return self.send_cmd(0x0006, bytes([int(filter_num)]))

    def set_peq_10band(self, bands: list, master_enabled: bool = True):
        """
        bands: list of 10 dicts:
        [{'freq': 1000, 'gain': 2.5, 'q': 1.41, 'type': 0, 'enabled': 1}, ...]
        """
        payload = bytearray(80)
        for i, b in enumerate(bands[:10]):
            offset = i * 8
            freq = int(b.get('freq', 1000))
            gain88 = int(round(float(b.get('gain', 0.0)) * 256))
            q100 = int(round(float(b.get('q', 1.41)) * 100))
            t = int(b.get('type', 0))
            en = 1 if b.get('enabled', True) else 0
            struct.pack_into('<HhHBB', payload, offset, freq, gain88, q100, t, en)
            
        self.send_cmd(0x0100, bytes(payload))
        self.send_cmd(0x0102, bytes([1 if master_enabled else 0]))

if __name__ == '__main__':
    ru3 = CayinRU3MacOS()
    ru3.set_volume(70)
    ru3.set_gain(True)
    ru3.set_work_mode(True)
    ru3.set_pcm_filter(1)
```

---

## 8. Audiophile Genre Preset Tuning Table

| Preset Name | Sonic Profile | 10-Band Gains (`dB`: 31Hz .. 16kHz) | Preamp |
| :--- | :--- | :--- | :---: |
| **Flat / Studio** | Neutral reference calibration | `[0, 0, 0, 0, 0, 0, 0, 0, 0]` | `0.0 dB` |
| **Jazz & Acoustic** | Warm mids, silky treble | `[+1.5, +2.0, +1.2, 0.0, -0.5, +0.8, +1.2, +2.0, +1.5, +2.2]` | `-2.2 dB` |
| **Classical** | Spatial depth, acoustic air | `[+2.0, +1.0, 0.0, -0.5, 0.0, +0.5, +1.0, +1.8, +2.2, +2.8]` | `-2.8 dB` |
| **Pop Vocal** | Vocal forward, punchy bass | `[+2.5, +3.2, +1.0, -1.0, 0.0, +1.5, +3.0, +2.5, +2.0, +1.8]` | `-3.2 dB` |
| **Rock Dynamic** | V-Shape energetic punch | `[+4.0, +3.0, +1.5, -0.5, -1.2, +0.5, +2.0, +3.5, +4.0, +3.8]` | `-4.0 dB` |
| **Dance / EDM** | Sub-bass impact & highs | `[+5.5, +4.5, +2.0, 0.0, -1.0, 0.0, +1.5, +3.0, +4.5, +5.0]` | `-5.5 dB` |
| **Hip-Hop & R&B** | Deep sub-rumble, crisp snare | `[+6.0, +4.8, +2.5, +0.5, -0.5, 0.0, +1.2, +2.0, +3.0, +3.5]` | `-6.0 dB` |
| **Vocal Presence** | Crystal clear forward voice | `[-2.0, -1.0, 0.0, +1.0, +2.2, +3.5, +3.2, +2.0, +1.0, +0.5]` | `-3.5 dB` |
| **Bass Impact** | Warm planar low-end boost | `[+6.5, +5.0, +3.0, +1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]` | `-6.5 dB` |
| **Treble Air** | Extended harmonic sparkle | `[0.0, 0.0, 0.0, 0.0, 0.0, +0.8, +1.8, +3.2, +4.5, +5.5]` | `-5.5 dB` |
