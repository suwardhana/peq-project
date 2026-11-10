"""Protocol-layer tests for the Protocol Micro (no DAC required).

The expected coefficient words are captured from real hardware
(scratch/protocol-micro-dump.json, taken from the unit on 2026-11-01),
so these tests fail if the biquad math or the blob layout drifts.
"""
import struct
import unittest

import micro
from micro import (BAND_COUNT, CMD_GLOBAL_GAIN, CMD_PEQ_VALUES, OP_READ,
                   OP_WRITE, REPORT_DATA, REPORT_ID, TransportError,
                   Controller, decode_band, decode_pregain, decode_version,
                   encode_band, frame, rbj_peak)

# (freq, Q, gain, type, captured coefficient words) — the gear used to build
# the preset in eq.hangout.audio, so the floats are the exact inputs.
CAPTURED = [
    (105, 0.7, 0.0, 'LSHELF', [1073741824, -2136943325, 1063251963,
                               2136943325, -1063251963]),
    (15000, 0.1, 0.0, 'PEAK', [1073741824, -231335558, -657348821,
                              231335558, 657348821]),
    (30, 0.5, -8.3, 'PEAK', [1071656277, -2140701755, 1069049604,
                             2140701755, -1066964057]),
    (360, 0.9, 3.5, 'PEAK', [1079382925, -2124158310, 1045365151,
                             2124158310, -1051006252]),
    (1600, 1.6, -1.5, 'PEAK', [1067885781, -2062279598, 1005753430,
                               2062279598, -999897387]),
    (2900, 1.9, 2.5, 'PEAK', [1088504119, -2021983233, 970455710,
                              2021983233, -985218005]),
    (4700, 2.0, -1.8, 'PEAK', [1058175112, -1888147849, 922970395,
                               1888147849, -907403683]),
    (13000, 1.5, -9.3, 'PEAK', [862209620, -991509410, 641567893,
                                991509410, -430035689]),
]


def report(command, data=b'', band=None, length=None):
    """Build a device-style reply (64 bytes, report id included)."""
    body = bytes(data)
    if band is not None:
        body = bytes([0x00, band, 0x00]) + body
    if length is None:
        length = len(body)
    packet = bytes([REPORT_ID, OP_READ, command, length]) + body
    return packet + bytes(64 - len(packet))


def band_report(band, freq, q, gain_db, type_id, slot=101, coeffs=b'\x00' * 20):
    body = bytearray(60)
    body[1] = band
    body[4:24] = coeffs
    body[24:26] = struct.pack('<H', freq)
    body[26:28] = struct.pack('<H', round(q * 256))
    body[28:30] = struct.pack('<h', round(gain_db * 256))
    body[30] = type_id
    body[32] = slot
    return report(CMD_PEQ_VALUES, bytes(body))


class FrameTests(unittest.TestCase):
    def test_report_is_64_bytes_with_report_id(self):
        packet = frame(CMD_PEQ_VALUES)
        self.assertEqual(len(packet), 1 + REPORT_DATA)
        self.assertEqual(packet[0], REPORT_ID)
        self.assertEqual(packet[1], OP_READ)
        self.assertEqual(packet[2], CMD_PEQ_VALUES)
        self.assertEqual(packet[3], 0x00)
        self.assertEqual(packet[4:], bytes(REPORT_DATA - 3))

    def test_length_byte_can_override_payload_size(self):
        # Mirrors the reference: a band record declares 0x18 but carries 34.
        packet = frame(CMD_PEQ_VALUES, OP_WRITE, bytes(34), length=0x18)
        self.assertEqual(packet[3], 0x18)

    def test_band_read_packet_matches_reference(self):
        packet = micro.band_read_packet(5)
        self.assertEqual(packet[:8], bytes([0x4B, 0x80, 0x09, 0x00, 0x00, 0x05,
                                            0x00, 0x00]))

    def test_band_read_rejects_out_of_range(self):
        for band in (-1, 8, '1', 1.0, True):
            with self.assertRaises(ValueError):
                micro.band_read_packet(band)

    def test_packet_too_long_is_rejected(self):
        with self.assertRaises(ValueError):
            frame(0x01, OP_WRITE, bytes(REPORT_DATA + 1))


class BlobTests(unittest.TestCase):
    def test_coefficients_match_captured_hardware(self):
        for index, (freq, q, gain, ftype, words) in enumerate(CAPTURED):
            with self.subTest(band=index):
                blob = micro.coeff_blob(freq, q, gain)
                self.assertEqual(len(blob), 20)
                self.assertEqual(list(struct.unpack('<5i', blob)), words)

    def test_peak_is_flat_at_zero_gain(self):
        b0, b1, b2, a1, a2 = rbj_peak(1000, 0.7, 0.0)
        self.assertAlmostEqual(b0, 1.0, places=9)
        self.assertAlmostEqual(b2, a2, places=12)
        self.assertAlmostEqual(b1, a1, places=12)

    def test_quantization_is_two_to_the_thirtieth(self):
        words = struct.unpack('<5i', micro.coeff_blob(105, 0.7, 0.0))
        self.assertEqual(words[0], 2 ** 30)


class EncodeBandTests(unittest.TestCase):
    def test_record_layout(self):
        packet = encode_band(3, 360, 0.9, 3.5, 'PEAK')
        self.assertEqual(len(packet), 1 + REPORT_DATA)
        self.assertEqual(packet[1], OP_WRITE)
        self.assertEqual(packet[2], CMD_PEQ_VALUES)
        self.assertEqual(packet[3], 0x18)
        self.assertEqual(packet[4:8], bytes([0x00, 3, 0x00, 0x00]))
        self.assertEqual(packet[8:28], micro.coeff_blob(360, 0.9, 3.5))
        self.assertEqual(packet[28:30], struct.pack('<H', 360))
        self.assertEqual(packet[30:32], struct.pack('<H', round(0.9 * 256)))
        self.assertEqual(packet[32:34], struct.pack('<h', round(3.5 * 256)))
        self.assertEqual(packet[34], 2)          # PEAK
        self.assertEqual(packet[35], 0x00)
        self.assertEqual(packet[36], micro.DEFAULT_SLOT)
        self.assertEqual(packet[37], 0x00)

    def test_all_types_map_to_captured_ids(self):
        for name, type_id in (('LSHELF', 1), ('PEAK', 2), ('HSHELF', 3),
                              ('LPF', 4), ('HPF', 5)):
            with self.subTest(type=name):
                self.assertEqual(
                    encode_band(0, 1000, 1.0, 1.0, name)[34], type_id)

    def test_rejects_invalid_input(self):
        bad = [
            dict(band=8, freq=1000, Q=1, gain_db=0, filter_type='PEAK'),
            dict(band=0, freq=10, Q=1, gain_db=0, filter_type='PEAK'),
            dict(band=0, freq=1000, Q=0.05, gain_db=0, filter_type='PEAK'),
            dict(band=0, freq=1000, Q=1, gain_db=13, filter_type='PEAK'),
            dict(band=0, freq=1000, Q=1, gain_db=-13, filter_type='PEAK'),
            dict(band=0, freq=1000, Q=1, gain_db=0, filter_type='NOTCH'),
            dict(band=0, freq=1000, Q=True, gain_db=0, filter_type='PEAK'),
        ]
        for kwargs in bad:
            with self.subTest(kwargs=kwargs):
                with self.assertRaises(ValueError):
                    encode_band(**kwargs)

    def test_accepts_plus_minus_12_db(self):
        for gain in (-12, -10.5, 12):
            packet = encode_band(0, 9900, 2.0, gain, 'PEAK')
            self.assertEqual(struct.unpack('<h', packet[32:34])[0],
                             round(gain * 256))

    def test_bypass_encodes_flat_peak(self):
        packet = encode_band(3, 360, 0.9, 0, 'BYPASS')
        self.assertEqual(packet[34], 2)          # stored as PEAK
        self.assertEqual(packet[32:34], b'\x00\x00')
        self.assertEqual(packet[8:28], micro.coeff_blob(360, 0.9, 0.0))


class DecodeTests(unittest.TestCase):
    def test_decode_band(self):
        coeffs = micro.coeff_blob(360, 0.9, 3.5)
        decoded = decode_band(band_report(2, 360, 0.9, 3.5, 2, coeffs=coeffs))
        self.assertEqual(decoded['band'], 2)
        self.assertEqual(decoded['freq'], 360)
        self.assertAlmostEqual(decoded['q'], round(0.9 * 256) / 256)
        self.assertAlmostEqual(decoded['gain_db'], 3.5)
        self.assertEqual(decoded['type_name'], 'PEAK')
        self.assertEqual(decoded['slot'], 101)
        self.assertEqual(decoded['coeffs_hex'], coeffs.hex())

    def test_decode_flat_band_is_bypass(self):
        coeffs = micro.coeff_blob(1000, 0.71, 0.0)
        for type_id in (1, 2, 3):
            decoded = decode_band(band_report(0, 1000, 0.71, 0.0, type_id,
                                              coeffs=coeffs))
            self.assertEqual(decoded['type'], type_id)
            self.assertEqual(decoded['type_name'], 'BYPASS')
        # LPF/HPF at 0 dB still filter, so they keep their name.
        decoded = decode_band(band_report(0, 1000, 0.71, 0.0, 4,
                                          coeffs=coeffs))
        self.assertEqual(decoded['type_name'], 'LPF')

    def test_decode_band_rejects_foreign_report(self):
        with self.assertRaises(ValueError):
            decode_band(bytes(64))

    def test_decode_pregain_is_signed(self):
        self.assertEqual(decode_pregain(report(CMD_GLOBAL_GAIN,
                                               bytes([0x00, 0xFA]))), -6)
        self.assertEqual(decode_pregain(report(CMD_GLOBAL_GAIN,
                                               bytes([0x00, 0x00]))), 0)

    def test_decode_version(self):
        self.assertEqual(decode_version(report(0x0C, b'0.2\x00\x00',
                                               length=0x00)), '0.2')


class FakeDevice:
    """Minimal HID stand-in: each write queues one reply, writes are stored."""

    def __init__(self, bands):
        # band -> (freq, q, gain, type_id)
        self.bands = {b[0]: tuple(b[1:]) for b in bands}
        self.stored = {}
        self.writes = []
        self._pending = None

    def read(self, size, timeout_ms=None):
        packet, self._pending = self._pending, None
        return self._reply_for(packet) if packet else []

    def write(self, packet):
        packet = bytes(packet)
        self.writes.append(packet)
        self._pending = packet
        return len(packet)

    def close(self):
        pass

    def _reply_for(self, packet):
        opcode, cmd = packet[1], packet[2]
        if opcode == OP_WRITE:
            if cmd == CMD_PEQ_VALUES:      # store + echo the record back
                band = packet[5]
                spec = (struct.unpack('<H', packet[28:30])[0],
                        struct.unpack('<H', packet[30:32])[0] / 256,
                        struct.unpack('<h', packet[32:34])[0] / 256,
                        packet[34])
                self.stored[band] = spec
                return list(band_report(band, *spec, coeffs=bytes(packet[8:28])))
            return []
        if cmd == micro.CMD_VERSION:
            return list(report(0x0C, b'0.2\x00', length=0x00))
        if cmd == CMD_GLOBAL_GAIN:
            return list(report(CMD_GLOBAL_GAIN, bytes([0x00, 0x00])))
        spec = self.stored.get(packet[5]) or self.bands.get(packet[5])
        if spec is None:
            return []
        freq, q, gain, type_id = spec
        return list(band_report(packet[5], freq, q, gain, type_id,
                                coeffs=micro.coeff_blob(freq, q, gain)))


TABLE = [(i, freq, q, gain, micro.PEQ_TYPE_IDS[ftype])
         for i, (freq, q, gain, ftype, _) in enumerate(CAPTURED)]


class ControllerTests(unittest.TestCase):
    def make(self):
        device = FakeDevice(TABLE)
        return device, Controller(device)

    def test_read_state_reads_eight_bands(self):
        device, controller = self.make()
        state = controller.read_state()
        self.assertEqual(state['firmware'], '0.2')
        self.assertEqual(len(state['bands']), BAND_COUNT)
        self.assertEqual(state['bands'][0]['freq'], 105)
        self.assertEqual(state['slot'], 101)
        self.assertEqual(state['status'], 'verified')

    def test_set_peq_writes_unlock_burst_and_verifies(self):
        device, controller = self.make()
        bands = [{'freq': freq, 'q': q, 'gain': gain, 'type': ftype}
                 for freq, q, gain, ftype, _ in CAPTURED]
        result = controller.set_peq(bands)
        self.assertTrue(all(b['verified'] for b in result['bands']))

        labels = [t.get('label') for t in controller.transactions]
        self.assertEqual(labels[:3], ['unlock_a', 'unlock_b', 'band'])
        self.assertIn('apply', labels)
        self.assertIn('flash', labels)
        self.assertLess(labels.index('band'), labels.index('apply'))
        self.assertLess(labels.index('apply'), labels.index('flash'))
        band_writes = [t for t in controller.transactions
                       if t.get('label') == 'band']
        self.assertEqual(len(band_writes), BAND_COUNT)
        self.assertTrue(all(t['tx_hex'][6:8] == '18' for t in band_writes))

    def test_set_peq_rejects_wrong_band_count(self):
        device, controller = self.make()
        with self.assertRaises(ValueError):
            controller.set_peq([])
        with self.assertRaises(ValueError):
            controller.set_peq([{}] * 9)

    def test_set_peq_accepts_bypass_and_plus_12(self):
        device, controller = self.make()
        bands = [{'freq': 9900, 'q': 2.0, 'gain': 12, 'type': 'PEAK'}]
        for i in range(1, BAND_COUNT):
            bands.append({'freq': 1000 + i, 'q': 0.71, 'gain': 0,
                          'type': 'BYPASS'})
        result = controller.set_peq(bands)
        self.assertTrue(all(b['verified'] for b in result['bands']))
        self.assertEqual(result['bands'][0]['gain_db'], 12)
        self.assertEqual(result['bands'][0]['type'], 'PEAK')
        self.assertEqual(result['bands'][1]['type'], 'BYPASS')

    def test_set_pregain_verifies_readback(self):
        device, controller = self.make()
        state = {'value': 0}
        original = device._reply_for

        def reply(packet):
            if packet[2] == CMD_GLOBAL_GAIN:
                if packet[1] == OP_WRITE:
                    state['value'] = packet[5]
                return list(report(CMD_GLOBAL_GAIN,
                                   bytes([0x00, state['value']])))
            return original(packet)

        device._reply_for = reply
        self.assertTrue(controller.set_pregain(-3)['verified'])
        writes = [t for t in controller.transactions
                  if t.get('label') == 'pregain']
        self.assertEqual(writes[0]['tx_hex'][:10], '4b01030200')

    def test_set_pregain_rejects_out_of_range(self):
        device, controller = self.make()
        for value in (1, -13, 'x', True):
            with self.assertRaises(ValueError):
                controller.set_pregain(value)

    def test_read_raises_on_timeout(self):
        device, controller = self.make()
        device.read = lambda size, timeout_ms=None: []
        with self.assertRaises(TransportError):
            controller.read(micro.CMD_VERSION, timeout=0.01)


if __name__ == '__main__':
    unittest.main()
