"""Cayin RU3 controller (v2) — real protocol captured from the official app.

Wire format: 64-byte HID report, report ID 75 (0x4B). No checksum.
  [0]    report ID (0x4B)
  [1]    opcode: 0x80 = GET, 0x01 = SET
  [2]    command ID (one byte)
  [3]    payload length N
  [4:4+N] payload, zero-padded to 64 bytes total.

A GET response echoes ``[0x4B, 0x80, cmd, len, data...]`` where len repeats
the request length (0x00 for simple queries, 0x21 for band records).
Simple SETs receive no response; callers must verify with a GET read-back.
See PROTOCOL.md for the command map and capture evidence.
"""
import argparse
from datetime import datetime, timezone
import json
import math
from pathlib import Path
import time

VID = 0x2D87
PIDS = {0x003B: 2, 0x003A: 1}
REPORT_ID = 0x4B

OP_GET = 0x80
OP_SET = 0x01

CMD_COMMIT = 0x01
CMD_GAIN = 0x03
CMD_PEQ_BAND = 0x09
CMD_PEQ_APPLY = 0x0A
CMD_FIRMWARE = 0x0C
CMD_FILTER = 0x11
CMD_EQ_PRESET = 0x1A
CMD_UAC = 0x1E
CMD_WORK_MODE = 0x21
CMD_OUTPUT = 0x22
CMD_VOLUME = 0x23

GAIN = {0: 'LOW', 1: 'HIGH'}
OUTPUT = {0: 'PO', 1: 'LO'}
WORK_MODE = {0: 'STD', 1: 'HYP'}
UAC = {0: 'UAC1', 1: 'UAC2'}
USER_GEQ = 8
USER_PEQ = 9
GEQ_FREQS = (32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000)
GEQ_Q = 0.71
EQ_PRESET = {0: 'OFF', USER_GEQ: 'Graphic', USER_PEQ: 'Parametric'}
DAC_FILTER = {0: 'Minimum Phase', 1: 'Linear phase trace rapid roll-off'}

# Exact 33-byte band query payload from the app capture (band index at [1]).
BAND_QUERY = bytes([
    0x09, 0x00, 0x00, 0x00, 0xFF, 0xFF, 0xFF, 0x7F,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0xC0, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x01,
])

PEQ_FS = 96000
PEQ_TYPE_IDS = {'BYPASS': 0, 'LSHELF': 1, 'PEAK': 2, 'HSHELF': 3,
                'LPF': 4, 'HPF': 5}
PEQ_TYPE = {type_id: name for name, type_id in PEQ_TYPE_IDS.items()}
# Types 0/4/5 and the shelf/pass coefficient mapping are presumed from the
# app UI order and the RBJ cookbook; only PEAK blobs are capture-verified.


class TransportError(Exception):
    pass


def frame(opcode, command, payload=b''):
    if opcode not in (OP_GET, OP_SET):
        raise ValueError('opcode must be 0x80 (GET) or 0x01 (SET)')
    if type(command) is not int or not 0 <= command <= 0xFF:
        raise ValueError('command must be a byte')
    payload = bytes(payload)
    if len(payload) > 60:
        raise ValueError('payload exceeds 60 bytes')
    packet = bytes([REPORT_ID, opcode, command, len(payload)]) + payload
    return packet + bytes(64 - len(packet))


def parse_response(report, command):
    """Return the data bytes of a GET response, validating cmd/echo."""
    data = bytes(report)
    if len(data) != 64 or data[0] != REPORT_ID or data[1] != OP_GET:
        raise ValueError('not a RU3 GET response: %s' % data[:8].hex())
    if data[2] != command:
        raise ValueError('response for 0x%02x, expected 0x%02x'
                         % (data[2], command))
    return data[4:]


def band_query_payload(band, preset=USER_PEQ):
    if type(band) is not int or not 0 <= band <= 9:
        raise ValueError('band must be 0..9')
    if type(preset) is not int or preset not in (USER_GEQ, USER_PEQ):
        raise ValueError('user preset must be 8 (GEQ) or 9 (PEQ)')
    query = bytearray(BAND_QUERY)
    query[0] = preset
    query[1] = band
    return bytes(query)


def decode_band(payload, preset=USER_PEQ):
    """Decode a 33-byte PEQ band record into plain parameters."""
    payload = bytes(payload)
    if len(payload) < 33 or payload[0] != preset:
        raise ValueError('not a band record for preset %d' % preset)
    gain_raw = int.from_bytes(payload[28:30], 'little', signed=True)
    return {
        'band': payload[1],
        'freq': int.from_bytes(payload[24:26], 'little'),
        'q': int.from_bytes(payload[26:28], 'little') / 256,
        'gain_db': gain_raw / 256,
        'type': payload[30],
        'type_name': PEQ_TYPE.get(payload[30]),
        'enabled': payload[32],
        'coeffs_hex': payload[4:24].hex(),
    }


def decode_c_string(data):
    return bytes(data).split(b'\x00')[0].decode('ascii', errors='replace')


def rbj_normalized(filter_type, freq, Q, gain_db, fs=PEQ_FS):
    """RBJ cookbook biquads, normalized (a0 = 1). Returns b0,b1,b2,a1,a2."""
    A = 10.0 ** (gain_db / 40.0)
    w = 2 * math.pi * freq / fs
    c, s = math.cos(w), math.sin(w)
    alpha = s / (2 * Q)
    if filter_type == 'PEAK':
        b0, b1, b2 = 1 + alpha * A, -2 * c, 1 - alpha * A
        a0, a1, a2 = 1 + alpha / A, -2 * c, 1 - alpha / A
    elif filter_type in ('LSHELF', 'HSHELF'):
        sq = 2 * math.sqrt(A) * alpha
        if filter_type == 'LSHELF':
            b0 = A * ((A + 1) - (A - 1) * c + sq)
            b1 = 2 * A * ((A - 1) - (A + 1) * c)
            b2 = A * ((A + 1) - (A - 1) * c - sq)
            a0 = (A + 1) + (A - 1) * c + sq
            a1 = -2 * ((A - 1) + (A + 1) * c)
            a2 = (A + 1) + (A - 1) * c - sq
        else:
            b0 = A * ((A + 1) + (A - 1) * c + sq)
            b1 = -2 * A * ((A - 1) + (A + 1) * c)
            b2 = A * ((A + 1) + (A - 1) * c - sq)
            a0 = (A + 1) - (A - 1) * c + sq
            a1 = 2 * ((A - 1) - (A + 1) * c)
            a2 = (A + 1) - (A - 1) * c - sq
    elif filter_type in ('LPF', 'HPF'):
        if filter_type == 'LPF':
            b0, b1, b2 = (1 - c) / 2, 1 - c, (1 - c) / 2
        else:
            b0, b1, b2 = (1 + c) / 2, -(1 + c), (1 + c) / 2
        a0, a1, a2 = 1 + alpha, -2 * c, 1 - alpha
    else:
        raise ValueError('unknown PEQ type %r' % (filter_type,))
    return b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0


def encode_band(band, freq, Q, gain_db, filter_type, preset=USER_PEQ):
    """Build a 33-byte PEQ band record, app-compatible to +-1 LSB (PEAK)."""
    if type(band) is not int or not 0 <= band <= 9:
        raise ValueError('band must be 0..9')
    if type(preset) is not int or preset not in (USER_GEQ, USER_PEQ):
        raise ValueError('user preset must be 8 (GEQ) or 9 (PEQ)')
    if type(freq) is not int or not 20 <= freq <= 20000:
        raise ValueError('freq must be an integer 20..20000')
    if isinstance(Q, bool) or not isinstance(Q, (int, float)) \
            or not 0.1 <= Q <= 10:
        raise ValueError('Q must be a number 0.1..10')
    if isinstance(gain_db, bool) or not isinstance(gain_db, (int, float)) \
            or not -12.0 <= gain_db <= 12.0:
        raise ValueError('gain_db must be a number -12..+12')
    Q, gain_db = float(Q), float(gain_db)
    if filter_type not in PEQ_TYPE_IDS:
        raise ValueError('unknown PEQ type %r' % (filter_type,))
    if filter_type == 'BYPASS':
        coeffs = rbj_normalized('PEAK', freq, Q, 0.0)
    elif filter_type in ('LPF', 'HPF'):
        coeffs = rbj_normalized(filter_type, freq, Q, 0.0)
    else:
        coeffs = rbj_normalized(filter_type, freq, Q, gain_db)
    b0n, b1n, b2n, a1n, a2n = coeffs
    words = [b0n, b1n + 2, b2n, a1n + 2, a2n]
    record = bytearray(33)
    record[0] = preset
    record[1] = band
    for i, value in enumerate(words):
        word = round(value * 2**31)
        if word == 0x80000000:
            word = 0x7FFFFFFF  # app emits 7FFFFFFF for unity b0
        record[4 + 4 * i:8 + 4 * i] = (word & 0xFFFFFFFF).to_bytes(4, 'little')
    record[24:26] = freq.to_bytes(2, 'little')
    record[26:28] = round(Q * 256).to_bytes(2, 'little')
    record[28:30] = round(gain_db * 256).to_bytes(2, 'little', signed=True)
    record[30] = PEQ_TYPE_IDS[filter_type]
    record[32] = 1
    return bytes(record)


def label(table, value):
    return table.get(value)


class Controller:
    def __init__(self, device):
        self.device = device
        self.transactions = []

    def _drain(self):
        stale = []
        for _ in range(32):
            report = self.device.read(64, 1)
            if not report:
                break
            stale.append(bytes(report).hex())
        return stale

    def _write(self, packet):
        written = self.device.write(packet)
        if written != len(packet):
            raise TransportError(
                'incomplete HID write: %r of %d bytes' % (written, len(packet)))

    def get(self, command, payload=b'', timeout=1.0):
        """Send GET, return the 60 data bytes of the matching response."""
        record = {'op': 'GET', 'command': '0x%02x' % command,
                  'stale_reports': self._drain(), 'stray': []}
        self.transactions.append(record)
        packet = frame(OP_GET, command, payload)
        record['tx_hex'] = packet.hex()
        self._write(packet)
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            reply = self.device.read(64, 100)
            if not reply:
                continue
            raw = bytes(reply)
            if (len(raw) == 64 and raw[0] == REPORT_ID
                    and raw[1] == OP_GET and raw[2] == command):
                record['rx_hex'] = raw.hex()
                record['status'] = 'ok'
                return raw[4:]
            record['stray'].append(raw.hex())
        record['status'] = 'no_response'
        raise TransportError('no response to GET 0x%02x' % command)

    def set(self, command, payload=b''):
        """Fire-and-forget SET (the DAC sends no ACK for simple SETs)."""
        record = {'op': 'SET', 'command': '0x%02x' % command,
                  'stale_reports': self._drain()}
        self.transactions.append(record)
        packet = frame(OP_SET, command, payload)
        record['tx_hex'] = packet.hex()
        self._write(packet)
        record['status'] = 'sent_no_ack_expected'

    def get_u8(self, command):
        return self.get(command)[0]

    def set_u8(self, command, value):
        if type(value) is not int or not 0 <= value <= 0xFF:
            raise ValueError('value must be a byte')
        self.set(command, bytes([value]))

    def commit(self):
        self.set(CMD_COMMIT)

    def read_state(self):
        state, errors = {}, {}

        def query(name, command, table=None, raw_hex=False):
            try:
                data = self.get(command)
                value = data[0]
                state[name] = value
                if table is not None:
                    state[name + '_label'] = label(table, value)
                if raw_hex:
                    state[name + '_hex'] = data[:8].hex()
            except (TransportError, OSError) as exc:
                state[name] = None
                errors[name] = str(exc)

        query('volume', CMD_VOLUME)
        query('gain', CMD_GAIN, GAIN)
        query('output', CMD_OUTPUT, OUTPUT)
        query('work_mode', CMD_WORK_MODE, WORK_MODE)
        query('eq', CMD_EQ_PRESET, EQ_PRESET)
        query('uac', CMD_UAC, UAC)
        query('filter', CMD_FILTER, DAC_FILTER)
        for name, command in (('unknown_16', 0x16), ('unknown_1f', 0x1F),
                              ('unknown_20', 0x20), ('unknown_24', 0x24)):
            query(name, command, raw_hex=True)
        try:
            state['firmware'] = decode_c_string(self.get(CMD_FIRMWARE))
        except (TransportError, OSError) as exc:
            state['firmware'] = None
            errors['firmware'] = str(exc)
        state['settings_status'] = 'verified' if not errors else 'partial'
        if errors:
            state['errors'] = errors
        return state

    def set_volume(self, value):
        if type(value) is not int or not 0 <= value <= 100:
            raise ValueError('Volume must be an integer from 0 to 100')
        self.set_u8(CMD_VOLUME, value)
        try:
            readback = self.get_u8(CMD_VOLUME)
        except (TransportError, OSError) as exc:
            return {'requested_volume': value, 'readback': None,
                    'verified': False, 'error': str(exc)}
        return {'requested_volume': value, 'readback': readback,
                'verified': readback == value}

    def get_band(self, band):
        return decode_band(self.get(CMD_PEQ_BAND, band_query_payload(band))[:33])

    def get_peq(self):
        return [self.get_band(i) for i in range(10)]

    def get_geq(self):
        """Read the independent USER_GEQ bank without changing active EQ."""
        bands = []
        for i in range(len(GEQ_FREQS)):
            back = self.get(CMD_PEQ_BAND, band_query_payload(i, USER_GEQ))[:33]
            try:
                band = decode_band(back, USER_GEQ)
            except ValueError as exc:
                raise TransportError('invalid GEQ reply: %s' % exc) from exc
            if band['band'] != i:
                raise TransportError('GEQ reply for wrong band: %d' % band['band'])
            bands.append(band)
        return {'preset': USER_GEQ, 'frequencies': list(GEQ_FREQS),
                'q': GEQ_Q, 'bands': bands}

    def set_geq(self, gains, max_passes=3):
        """Save ten fixed-frequency PEAK bands to USER_GEQ, then verify.

        Mirrors the OEM GEQ slider: preset 8, Q 0.71, apply [8,0,0,0],
        commit. All input is checked before writing. Dropped packets are
        retried selectively. Neither USER_PEQ nor the active preset changes.
        """
        if not isinstance(gains, list) or len(gains) != len(GEQ_FREQS):
            raise ValueError('GEQ needs exactly 10 gains')
        records = [encode_band(i, freq, GEQ_Q, gains[i], 'PEAK', USER_GEQ)
                   for i, freq in enumerate(GEQ_FREQS)]
        pending = list(range(len(records)))
        results = {}
        for _ in range(max(1, max_passes)):
            for i in pending:
                self.set(CMD_PEQ_BAND, records[i])
                time.sleep(0.025)
            self.set(CMD_PEQ_APPLY, bytes([USER_GEQ, 0, 0, 0]))
            time.sleep(0.025)
            self.commit()
            time.sleep(0.15)
            for i in pending:
                try:
                    back = bytes(self.get(CMD_PEQ_BAND,
                                          band_query_payload(i, USER_GEQ))[:33])
                    results[i] = {'band': i, 'verified': back == records[i]}
                except (TransportError, OSError) as exc:
                    results[i] = {'band': i, 'verified': False,
                                  'error': str(exc)}
            pending = [i for i in pending if not results[i]['verified']]
            if not pending:
                break
        return [results[i] for i in range(len(records))]

    def set_band(self, band, freq, Q, gain_db, filter_type):
        """Write one band record (no apply/commit; caller batches those)."""
        self.set(CMD_PEQ_BAND, encode_band(band, freq, Q, gain_db, filter_type))

    def set_peq(self, bands):
        """Write a full 10-band preset, apply, commit, verify by read-back.

        bands: list of 10 dicts with freq/Q/gain/type. Returns per-band
        verification against a fresh read-back.
        """
        if not isinstance(bands, list) or len(bands) != 10:
            raise ValueError('set_peq needs a list of exactly 10 bands')
        records = [encode_band(i, b['freq'], b['q'], b['gain'], b['type'])
                   for i, b in enumerate(bands)]
        for record in records:
            self.set(CMD_PEQ_BAND, record)
            time.sleep(0.025)  # device drops back-to-back writes
        self.set(CMD_PEQ_APPLY, bytes([0x09, 0x00, 0x00, 0x00]))
        time.sleep(0.025)
        self.commit()
        time.sleep(0.15)
        result = []
        for i, record in enumerate(records):
            try:
                back = bytes(self.get(CMD_PEQ_BAND,
                                      band_query_payload(i))[:33])
            except (TransportError, OSError) as exc:
                result.append({'band': i, 'verified': False,
                               'error': str(exc)})
                continue
            result.append({'band': i, 'verified': back == record,
                           'match_bytes': sum(a == b for a, b in
                                              zip(back, record))})
        return result


def open_device():
    import hid
    devices = [d for d in hid.enumerate(VID, 0) if d['product_id'] in PIDS]
    if len(devices) != 1:
        raise TransportError(
            'expected exactly one RU3 HID interface, found %d' % len(devices))
    device = hid.device()
    device.open_path(devices[0]['path'])
    device.set_nonblocking(0)
    return device, devices[0]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--set-volume', type=int, metavar='0..100')
    parser.add_argument('--dump-peq', action='store_true')
    parser.add_argument('--set-peq', metavar='PRESET.json',
                        help='apply 10-band preset '
                             '({"bands": [{freq,q,gain,type} x10]})')
    args = parser.parse_args()
    result = {'timestamp': datetime.now(timezone.utc).isoformat(), 'version': 2,
              'protocol': '4B/op/cmd/len, no checksum (captured from app)',
              'connected': False}
    device = None
    try:
        device, info = open_device()
        result.update(connected=True, product=info['product_string'],
                      product_id='0x%04x' % info['product_id'],
                      uac_from_pid=PIDS[info['product_id']])
        controller = Controller(device)
        result['transactions'] = controller.transactions
        result['before'] = controller.read_state()
        if args.set_volume is not None:
            result['volume_attempt'] = controller.set_volume(args.set_volume)
            result['after'] = controller.read_state()
        if args.dump_peq:
            result['peq'] = controller.get_peq()
        if args.set_peq is not None:
            preset = json.loads(Path(args.set_peq).read_text(encoding='utf-8'))
            result['peq_attempt'] = controller.set_peq(preset['bands'])
            result['peq_after'] = controller.get_peq()
    except (OSError, TransportError, ValueError) as exc:
        result['error'] = str(exc)
    finally:
        if device is not None:
            device.close()
    directory = Path(__file__).resolve().parent / 'logs'
    directory.mkdir(exist_ok=True)
    path = directory / (datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ') + '.json')
    path.write_text(json.dumps(result, indent=2), encoding='utf-8')
    print(json.dumps(result, indent=2))
    print('Log: %s' % path)
    return 1 if 'error' in result else 0


if __name__ == '__main__':
    raise SystemExit(main())
