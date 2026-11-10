"""CrinEar Protocol Micro controller — Walkplay HID family (SchemeNo11).

Verified against real hardware (VID 0x3302 / PID 0xC20F, USB product
"Protocol Micro", firmware "0.2") on 2026-11-01.  See PROTOCOL.md for the
evidence behind every constant in this file.

Wire format: 64-byte HID report, report ID 0x4B (63 payload bytes after it).

    [0]  report ID 0x4B
    [1]  opcode: 0x80 = READ, 0x01 = WRITE
    [2]  command
    [3]  payload length (0 for simple reads, 0x18 for a band record)
    [4..] payload

A READ answered by the device echoes [0x4B, 0x80, cmd, len, ...].  Writes are
fire-and-forget — no ACK — so every write is confirmed with a read-back.
"""
import argparse
from datetime import datetime, timezone
import json
import math
from pathlib import Path
import struct
import time

VID = 0x3302
PID = 0xC20F
REPORT_ID = 0x4B
REPORT_DATA = 63          # payload bytes the descriptor declares for 0x4B

OP_READ = 0x80
OP_WRITE = 0x01

CMD_FLASH_EQ = 0x01       # commit to flash; also the EQ enable/slot command
CMD_MIC_GAIN = 0x02
CMD_GLOBAL_GAIN = 0x03    # global (preamp) gain, signed int8 dB
CMD_UNLOCK_A = 0x05       # sent before each PEQ write burst by the app
CMD_PEQ_VALUES = 0x09     # 8-band PEQ records
CMD_APPLY = 0x0A          # "apply edited band" marker
CMD_VERSION = 0x0C        # ASCII firmware string
CMD_UNLOCK_B = 0x17       # second unlock byte of the write burst

BAND_COUNT = 8
DEFAULT_SLOT = 101        # "Custom" slot reported by the device
PEQ_FS = 96000
PEQ_SCALE = 2 ** 30       # blob words are Q1.30, NOT 2^31 like the RU3

# Device filter types, as stored in record byte 30 (wire byte 34).
# The device has no bypass id: a flat band is stored as PEAK at 0 dB, and the
# software layers present that as BYPASS.
PEQ_TYPE_IDS = {'LSHELF': 1, 'PEAK': 2, 'HSHELF': 3, 'LPF': 4, 'HPF': 5}
PEQ_TYPE = {type_id: name for name, type_id in PEQ_TYPE_IDS.items()}
BYPASS_TYPES = ('BYPASS', 'LSHELF', 'PEAK', 'HSHELF')

# Software limits. The firmware itself stores whatever it is given (verified
# with +-15 dB and Q 20), so these are the guards that keep a preset sane.
# Gain allows +-12 dB: +12 dB at 9900 Hz was confirmed audible over +10 dB on
# the unit (2026-11-01), and the reference family config documents +-10 dB.
GAIN_LIMIT = 12.0
Q_MIN, Q_MAX = 0.1, 10.0
FREQ_MIN, FREQ_MAX = 20, 20000
PREGAIN_MIN, PREGAIN_MAX = -12, 0


class TransportError(Exception):
    pass


def frame(command, opcode=OP_READ, payload=b'', length=None):
    """Build one 64-byte HID report.

    ``length`` overrides the length byte.  The reference implementation does
    not always agree with the payload size it sends (a band record declares
    0x18 while carrying 34 bytes; the apply marker declares 4 and carries 5),
    so the byte is passed through verbatim.
    """
    payload = bytes(payload)
    if length is None:
        length = len(payload)
    packet = bytes([REPORT_ID, opcode, command, length]) + payload
    if len(packet) > 1 + REPORT_DATA:
        raise ValueError('packet exceeds %d bytes' % (1 + REPORT_DATA))
    return packet + bytes(1 + REPORT_DATA - len(packet))


def band_read_packet(band):
    if type(band) is not int or not 0 <= band < BAND_COUNT:
        raise ValueError('band must be 0..%d' % (BAND_COUNT - 1))
    # Mirrors the reference request: length byte 0, band index at wire[5].
    return frame(CMD_PEQ_VALUES, OP_READ, bytes([0x00, band, 0x00]), length=0)


def rbj_peak(freq, Q, gain_db, fs=PEQ_FS):
    """The exact biquad the reference implementation quantizes for every type.

    Returns normalized b0,b1,b2,a1,a2 (a0 = 1).
    """
    A = math.sqrt(10.0 ** (gain_db / 20.0))
    w = 2 * math.pi * freq / fs
    s = math.sin(w) / (2 * Q)
    alpha_a, alpha_div_a = s * A, s / A
    norm = 1.0 + alpha_div_a
    a1 = (-2 * math.cos(w)) / norm
    a2 = (1.0 - alpha_div_a) / norm
    b0 = (1.0 + alpha_a) / norm
    b1 = (-2 * math.cos(w)) / norm
    b2 = (1.0 - alpha_a) / norm
    return b0, b1, b2, a1, a2


def coeff_blob(freq, Q, gain_db):
    """20-byte coefficient blob: 5 x int32 LE, Q1.30, order [b0,b1,b2,-a1,-a2]."""
    b0, b1, b2, a1, a2 = rbj_peak(freq, Q, gain_db)
    words = [b0, b1, b2, -a1, -a2]
    return b''.join(struct.pack('<i', round(word * PEQ_SCALE)) for word in words)


def encode_band(band, freq, Q, gain_db, filter_type, slot=DEFAULT_SLOT):
    """Build the 37-byte wire packet that writes one PEQ band."""
    if type(band) is not int or not 0 <= band < BAND_COUNT:
        raise ValueError('band must be 0..%d' % (BAND_COUNT - 1))
    if type(freq) is not int or not FREQ_MIN <= freq <= FREQ_MAX:
        raise ValueError('freq must be an integer %d..%d'
                         % (FREQ_MIN, FREQ_MAX))
    if isinstance(Q, bool) or not isinstance(Q, (int, float)) \
            or not Q_MIN <= Q <= Q_MAX:
        raise ValueError('Q must be a number %.1f..%.1f' % (Q_MIN, Q_MAX))
    if isinstance(gain_db, bool) or not isinstance(gain_db, (int, float)) \
            or not -GAIN_LIMIT <= gain_db <= GAIN_LIMIT:
        raise ValueError('gain_db must be a number -%g..+%g'
                         % (GAIN_LIMIT, GAIN_LIMIT))
    if filter_type not in PEQ_TYPE_IDS and filter_type != 'BYPASS':
        raise ValueError('unknown PEQ type %r' % (filter_type,))
    Q, gain_db = float(Q), float(gain_db)
    if filter_type == 'BYPASS':
        # No wire id: store a flat PEAK.  The blob at 0 dB is unity.
        gain_db, wire_type = 0.0, 'PEAK'
    else:
        wire_type = filter_type

    # The reference quantizes the caller's floats, not the Q8.8 values it
    # stores — that is why a read-back blob can differ from a blob recomputed
    # from the rounded record.  Keep the caller's values here too.
    payload = (bytes([0x00, band, 0x00, 0x00])
               + coeff_blob(freq, Q, gain_db)
               + struct.pack('<H', freq)
               + struct.pack('<H', round(Q * 256))
               + struct.pack('<h', round(gain_db * 256))
               + bytes([PEQ_TYPE_IDS[wire_type], 0x00, slot & 0xFF, 0x00]))
    return frame(CMD_PEQ_VALUES, OP_WRITE, payload, length=0x18)


def decode_band(report):
    """Decode a 64-byte band response into plain parameters."""
    data = bytes(report)
    if len(data) < 40 or data[0] != REPORT_ID or data[1] != OP_READ \
            or data[2] != CMD_PEQ_VALUES:
        raise ValueError('not a PEQ band response: %s' % data[:8].hex())
    freq, q_raw, gain_raw = struct.unpack('<HHh', data[28:34])
    raw_type = data[34]
    type_name = PEQ_TYPE.get(raw_type)
    if gain_raw == 0 and raw_type in (1, 2, 3):
        # A flat shelf/peak is unity: present it as BYPASS.
        type_name = 'BYPASS'
    return {
        'band': data[5],
        'freq': freq,
        'q': q_raw / 256,
        'gain_db': gain_raw / 256,
        'type': raw_type,
        'type_name': type_name,
        'slot': data[36],
        'coeffs_hex': data[8:28].hex(),
        'record_hex': data[5:37].hex(),
    }


def decode_pregain(report):
    data = bytes(report)
    if len(data) < 6 or data[0] != REPORT_ID or data[1] != OP_READ \
            or data[2] != CMD_GLOBAL_GAIN:
        raise ValueError('not a pregain response: %s' % data[:8].hex())
    return struct.unpack('b', bytes([data[5]]))[0]


def decode_version(report):
    data = bytes(report)
    if len(data) < 5 or data[0] != REPORT_ID or data[1] != OP_READ \
            or data[2] != CMD_VERSION:
        raise ValueError('not a version response: %s' % data[:8].hex())
    return bytes(data[4:]).split(b'\x00')[0].decode('ascii', errors='replace')


def _norm_type(type_name, gain_db):
    """BYPASS, PEAK, LSHELF and HSHELF at 0 dB are the same flat response."""
    if type_name in BYPASS_TYPES and gain_db == 0:
        return 'BYPASS'
    return type_name


class Controller:
    """Talks to one open Protocol Micro HID handle."""

    def __init__(self, device):
        self.device = device
        self.transactions = []

    # -- transport ---------------------------------------------------------
    def _drain(self):
        stale = []
        for _ in range(16):
            report = self.device.read(64, 1)
            if not report:
                break
            stale.append(bytes(report).hex())
        return stale

    def _write(self, packet):
        packet = bytes(packet)
        if packet[0] != REPORT_ID:
            raise TransportError('packet must start with report id 0x4B')
        body = packet[1:].ljust(REPORT_DATA, b'\x00')[:REPORT_DATA]
        written = self.device.write(bytes([REPORT_ID]) + body)
        if written is not None and written <= 0:
            raise TransportError('HID write failed: %r' % (written,))

    def read(self, command, payload=b'', band=None, timeout=1.5):
        record = {'op': 'READ', 'command': '0x%02x' % command,
                  'stale_reports': self._drain()}
        self.transactions.append(record)
        packet = (band_read_packet(band) if band is not None
                  else frame(command, OP_READ, payload))
        record['tx_hex'] = packet.hex()
        self._write(packet)

        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            reply = self.device.read(64, 100)
            if not reply:
                continue
            raw = bytes(reply)
            if len(raw) >= 4 and raw[0] == REPORT_ID and raw[1] == OP_READ \
                    and raw[2] == command:
                record['rx_hex'] = raw.hex()
                record['status'] = 'ok'
                return raw
            record.setdefault('stray', []).append(raw[:16].hex())
        record['status'] = 'no_response'
        raise TransportError('no response to READ 0x%02x' % command)

    def write(self, packet, label=''):
        """Fire-and-forget write (the device sends no ACK)."""
        record = {'op': 'WRITE', 'label': label,
                  'stale_reports': self._drain()}
        self.transactions.append(record)
        record['tx_hex'] = bytes(packet).hex()
        self._write(packet)
        record['status'] = 'sent_no_ack_expected'

    # -- simple commands ---------------------------------------------------
    def firmware(self):
        return decode_version(self.read(CMD_VERSION))

    def get_pregain(self):
        return decode_pregain(self.read(CMD_GLOBAL_GAIN))

    def set_pregain(self, value):
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError('pregain must be a number')
        value = int(round(value))
        if not PREGAIN_MIN <= value <= PREGAIN_MAX:
            raise ValueError('pregain must be %d..%d dB'
                             % (PREGAIN_MIN, PREGAIN_MAX))
        self.write(frame(CMD_GLOBAL_GAIN, OP_WRITE,
                         bytes([0x00, value & 0xFF])), 'pregain')
        time.sleep(0.05)
        readback = self.get_pregain()
        return {'requested_pregain': value, 'readback': readback,
                'verified': readback == value}

    # -- PEQ ---------------------------------------------------------------
    def get_band(self, band):
        return decode_band(self.read(CMD_PEQ_VALUES, band=band))

    def get_peq(self):
        bands = [self.get_band(i) for i in range(BAND_COUNT)]
        slot = next((b['slot'] for b in bands if b.get('slot')), DEFAULT_SLOT)
        return {'bands': bands, 'slot': slot,
                'pregain': self.get_pregain()}

    def _burst(self, records, slot):
        """Unlock, write every band, apply, flash — the order the app uses."""
        self.write(frame(CMD_UNLOCK_A, OP_WRITE), 'unlock_a')
        time.sleep(0.03)
        self.write(frame(CMD_UNLOCK_B, OP_WRITE), 'unlock_b')
        time.sleep(0.03)
        for record in records:
            self.write(record, 'band')
            time.sleep(0.03)
        self.write(frame(CMD_APPLY, OP_WRITE,
                         bytes([0x00, 0x00, 0xFF, 0xFF, 0x00]), length=0x04),
                   'apply')
        time.sleep(0.05)
        self.write(frame(CMD_FLASH_EQ, OP_WRITE), 'flash')
        time.sleep(0.9)

    def set_peq(self, bands, pregain=None, slot=DEFAULT_SLOT):
        """Write an 8-band preset, flash it, then verify by read-back.

        bands: list of 8 dicts with freq/Q/gain/type.
        Returns {'bands': [per-band verify], 'pregain': verify or None}.
        """
        if not isinstance(bands, list) or len(bands) != BAND_COUNT:
            raise ValueError('set_peq needs a list of exactly %d bands'
                             % BAND_COUNT)
        records = [encode_band(i, b['freq'], b['q'], b['gain'], b['type'], slot)
                   for i, b in enumerate(bands)]
        self._burst(records, slot)
        result = []
        for i in range(BAND_COUNT):
            try:
                back = decode_band(self.read(CMD_PEQ_VALUES, band=i))
            except (TransportError, OSError) as exc:
                result.append({'band': i, 'verified': False,
                               'error': str(exc)})
                continue
            wanted = bands[i]
            fields = (back['freq'] == wanted['freq']
                      and abs(back['gain_db'] - round(wanted['gain'] * 256) / 256) < 1e-9
                      and abs(back['q'] - round(wanted['q'] * 256) / 256) < 1e-9
                      and _norm_type(back['type_name'], back['gain_db'])
                      == _norm_type(wanted['type'], wanted['gain']))
            result.append({'band': i, 'verified': bool(fields),
                           'freq': back['freq'], 'q': back['q'],
                           'gain_db': back['gain_db'],
                           'type': back['type_name']})
        pregain_result = None
        if pregain is not None:
            pregain_result = self.set_pregain(pregain)
        return {'bands': result, 'pregain': pregain_result}

    def read_state(self):
        state = {'bands': [], 'errors': {}}
        try:
            state['firmware'] = self.firmware()
        except (TransportError, OSError) as exc:
            state['firmware'] = None
            state['errors']['firmware'] = str(exc)
        try:
            for i in range(BAND_COUNT):
                state['bands'].append(self.get_band(i))
            state['slot'] = state['bands'][0]['slot']
        except (TransportError, OSError) as exc:
            state['errors']['peq'] = str(exc)
        try:
            state['pregain'] = self.get_pregain()
        except (TransportError, OSError) as exc:
            state['pregain'] = None
            state['errors']['pregain'] = str(exc)
        state['status'] = 'verified' if not state['errors'] else 'partial'
        return state


def open_device():
    import hid
    devices = [d for d in hid.enumerate(VID, PID)]
    if len(devices) != 1:
        raise TransportError(
            'expected exactly one Protocol Micro HID interface (VID 0x%04x, '
            'PID 0x%04x), found %d' % (VID, PID, len(devices)))
    device = hid.device()
    device.open_path(devices[0]['path'])
    device.set_nonblocking(0)
    return device, devices[0]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dump', action='store_true', help='read full state')
    parser.add_argument('--set-peq', metavar='PRESET.json',
                        help='apply 8-band preset '
                             '({"bands": [{freq,q,gain,type} x8], "pregain": -3})')
    parser.add_argument('--set-pregain', type=int, metavar='DB')
    args = parser.parse_args()
    result = {'timestamp': datetime.now(timezone.utc).isoformat(),
              'protocol': 'walkplay/micro 4B/op/cmd/len, 8 bands, Q1.30 blob',
              'connected': False}
    device = None
    try:
        device, info = open_device()
        result.update(connected=True, product=info['product_string'],
                      product_id='0x%04x' % info['product_id'])
        controller = Controller(device)
        result['transactions'] = controller.transactions
        result['state'] = controller.read_state()
        if args.set_pregain is not None:
            result['pregain_attempt'] = controller.set_pregain(
                args.set_pregain)
        if args.set_peq is not None:
            preset = json.loads(Path(args.set_peq).read_text(encoding='utf-8'))
            result['peq_attempt'] = controller.set_peq(
                preset['bands'], preset.get('pregain'))
            result['state_after'] = controller.read_state()
    except (OSError, TransportError, ValueError) as exc:
        result['error'] = str(exc)
    finally:
        if device is not None:
            device.close()
    directory = Path(__file__).resolve().parent / 'logs'
    directory.mkdir(exist_ok=True)
    path = directory / (datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
                        + '.json')
    path.write_text(json.dumps(result, indent=2), encoding='utf-8')
    print(json.dumps(result, indent=2))
    print('Log: %s' % path)
    return 1 if 'error' in result else 0


if __name__ == '__main__':
    raise SystemExit(main())
