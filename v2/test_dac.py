import struct
import unittest

from dac import (BAND_QUERY, CMD_PEQ_BAND, CMD_VOLUME, OP_GET, OP_SET,
                 TransportError, band_query_payload, decode_band,
                 decode_c_string, encode_band, frame, parse_response,
                 Controller)

# Ground truth, byte-exact from v2/captures/*.txt (official Android app).
VOL_GET_TX = bytes.fromhex(
    '4b802300' + '00' * 60)
VOL_GET_RX = bytes.fromhex(
    '4b8023005a' + '00' * 59)
VOL_SET_89_TX = bytes.fromhex(
    '4b01230159' + '00' * 59)
FW_RX = bytes.fromhex(
    '4b800c0056312e302e33' + '00' * 54)
BANDQ_TX = bytes.fromhex(
    '4b80092109000000ffffff7f' + '00' * 18 + 'c0000000000001' + '00' * 27)
BANDQ_RX = bytes.fromhex(
    '4b80092109000000ffffff7fc9265f00d1fca07fc9265f00d1fca07f'
    '2000b6000000010001' + '00' * 27)
# App-computed coefficient blobs (v2/captures/gain_q071.txt, peq_editor_open).
# Inputs are bit-exact app state: Q loaded as field/256, gains float64-tapped.
APP_BLOBS = [
    ((1, 64, 182 / 256, 0.0 + 0.1, 'PEAK'),
     'ae1b018072f8bf009f7e3f7f72f8bf004e9a407f'),
    ((1, 64, 182 / 256, 0.0 + 0.1 + 0.1, 'PEAK'),
     '6237028006e0be00597b3f7f06e0be00bbb2417f'),
    ((1, 64, 182 / 256, 0.0 + 0.1 + 0.1 + 0.1, 'PEAK'),
     '1d53038033c9bd0071763f7f33c9bd008fc9427f'),
    ((1, 63, 0.71, 0.0, 'PEAK'),
     'ffffff7f0b4ebe002a40427f0b4ebe002a40427f'),
    ((9, 16000, 0.71, 0.0, 'PEAK'),
     'ffffff7f88a67db0efb2041f88a67db0efb2041f'),
]


def assert_blob_parity(case, mine, app_hex):
    mine_words = struct.unpack('<5I', mine[4:24])
    app_words = struct.unpack('<5I', bytes.fromhex(app_hex))
    for a, b in zip(mine_words, app_words):
        case.assertLessEqual(abs(a - b), 1, (mine.hex(), app_hex))


class FakeDevice:
    def __init__(self, reads=(), write_result=64):
        self.reads = list(reads)
        self.write_result = write_result
        self.writes = []

    def read(self, size, timeout_ms=None):
        if self.reads:
            return self.reads.pop(0)
        return []

    def write(self, packet):
        self.writes.append(bytes(packet))
        return self.write_result


class FrameTests(unittest.TestCase):
    def test_get_frame_matches_capture(self):
        self.assertEqual(frame(OP_GET, CMD_VOLUME), VOL_GET_TX)

    def test_set_frame_matches_capture(self):
        self.assertEqual(frame(OP_SET, CMD_VOLUME, bytes([89])), VOL_SET_89_TX)

    def test_band_query_matches_capture(self):
        self.assertEqual(frame(OP_GET, CMD_PEQ_BAND, band_query_payload(0)),
                         BANDQ_TX)

    def test_frame_rejects_bad_input(self):
        for args in [(0x00, 1), (OP_GET, 256), (OP_GET, 'x'),
                     (OP_GET, 1, bytes(61))]:
            with self.assertRaises(ValueError):
                frame(*args)


class ParseTests(unittest.TestCase):
    def test_parse_vol_response(self):
        self.assertEqual(parse_response(VOL_GET_RX, CMD_VOLUME)[0], 90)

    def test_parse_firmware(self):
        self.assertEqual(decode_c_string(parse_response(FW_RX, 0x0C)), 'V1.0.3')

    def test_parse_rejects_mismatch(self):
        with self.assertRaises(ValueError):
            parse_response(VOL_GET_RX, 0x03)
        with self.assertRaises(ValueError):
            parse_response(bytes(64), CMD_VOLUME)
        with self.assertRaises(ValueError):
            parse_response(bytes(10), CMD_VOLUME)

    def test_decode_band_from_capture(self):
        band = decode_band(parse_response(BANDQ_RX, CMD_PEQ_BAND)[:33])
        self.assertEqual(band['band'], 0)
        self.assertEqual(band['freq'], 32)
        self.assertAlmostEqual(band['q'], 182 / 256)
        self.assertEqual(band['gain_db'], 0.0)
        self.assertEqual(band['type'], 1)
        self.assertEqual(band['type_name'], 'LSHELF')
        self.assertEqual(band['enabled'], 1)

    def test_band_query_template_shape(self):
        self.assertEqual(len(BAND_QUERY), 33)
        self.assertEqual(band_query_payload(9)[1], 9)
        for bad in (-1, 10, '0'):
            with self.assertRaises(ValueError):
                band_query_payload(bad)


class ControllerTests(unittest.TestCase):
    def test_get_matches_response_by_cmd(self):
        stray = bytes([0x4B, OP_GET, 0x03, 0x00]) + bytes(60)
        dev = FakeDevice(reads=[[], stray, VOL_GET_RX])
        data = Controller(dev).get(CMD_VOLUME)
        self.assertEqual(data[0], 90)
        self.assertEqual(dev.writes, [VOL_GET_TX])

    def test_get_timeout_raises_without_fake_data(self):
        controller = Controller(FakeDevice())
        with self.assertRaises(TransportError):
            controller.get(CMD_VOLUME, timeout=0.05)
        self.assertEqual(controller.transactions[0]['status'], 'no_response')

    def test_short_write_raises(self):
        dev = FakeDevice(write_result=0)
        with self.assertRaises(TransportError):
            Controller(dev).set(CMD_VOLUME, bytes([85]))
        dev = FakeDevice(write_result=0)
        with self.assertRaises(TransportError):
            Controller(dev).get(CMD_VOLUME, timeout=0.05)

    def test_invalid_volume_never_reaches_transport(self):
        dev = FakeDevice()
        controller = Controller(dev)
        for value in (-1, 101, 85.5, True, '85'):
            with self.assertRaises(ValueError):
                controller.set_volume(value)
        self.assertEqual(dev.writes, [])

    def test_set_volume_verifies_readback(self):
        rx85 = bytes([0x4B, OP_GET, CMD_VOLUME, 0x00, 85]) + bytes(59)
        dev = FakeDevice(reads=[[], [], rx85])
        result = Controller(dev).set_volume(85)
        self.assertTrue(result['verified'])
        self.assertEqual(result['readback'], 85)
        self.assertEqual(dev.writes[0], frame(OP_SET, CMD_VOLUME, bytes([85])))

    def test_set_volume_reports_mismatch(self):
        rx90 = bytes([0x4B, OP_GET, CMD_VOLUME, 0x00, 90]) + bytes(59)
        dev = FakeDevice(reads=[[], [], rx90])
        result = Controller(dev).set_volume(85)
        self.assertFalse(result['verified'])
        self.assertEqual(result['readback'], 90)


class EncodeTests(unittest.TestCase):
    def test_encode_matches_app_within_1lsb(self):
        for (band, freq, Q, gain, ftype), app_hex in APP_BLOBS:
            assert_blob_parity(self, encode_band(band, freq, Q, gain, ftype),
                               app_hex)

    def test_encode_decode_roundtrip(self):
        record = encode_band(3, 250, 1.41, -3.5, 'PEAK')
        band = decode_band(record)
        self.assertEqual((band['band'], band['freq'], band['type_name']),
                         (3, 250, 'PEAK'))
        self.assertAlmostEqual(band['gain_db'], -3.5, places=2)
        self.assertAlmostEqual(band['q'], 1.41, places=2)

    def test_encode_rejects_bad_input(self):
        good = dict(band=0, freq=32, Q=0.71, gain_db=0.0, filter_type='PEAK')
        bads = [dict(good, band=10), dict(good, band='0'),
                dict(good, freq=19), dict(good, freq=20001),
                dict(good, freq=32.0), dict(good, Q=0.05),
                dict(good, Q=11), dict(good, Q=True),
                dict(good, gain_db=12.1), dict(good, gain_db=-12.1),
                dict(good, gain_db=False), dict(good, filter_type='NOPE')]
        for kwargs in bads:
            with self.assertRaises(ValueError, msg=kwargs):
                encode_band(**kwargs)
        encode_band(0, 32, 1, 3, 'PEAK')

    def test_decode_maps_all_supported_type_ids(self):
        expected = {
            'BYPASS': 0,
            'LSHELF': 1,
            'PEAK': 2,
            'HSHELF': 3,
            'LPF': 4,
            'HPF': 5,
        }
        for type_name, type_id in expected.items():
            record = bytearray(encode_band(0, 1000, 0.71, 0.0, 'BYPASS'))
            record[30] = type_id
            decoded = decode_band(record)
            self.assertEqual(decoded['type'], type_id)
            self.assertEqual(decoded['type_name'], type_name)


class SetPeqTests(unittest.TestCase):
    def test_full_apply_sequence_and_verify(self):
        bands = [{'freq': 32 + i, 'q': 0.71, 'gain': 0.0, 'type': 'PEAK'}
                 for i in range(10)]
        records = [encode_band(i, b['freq'], b['q'], b['gain'], b['type'])
                   for i, b in enumerate(bands)]
        reads = [[]] * 12
        for i, record in enumerate(records):
            reads += [[], bytes([0x4B, OP_GET, CMD_PEQ_BAND, 0x21])
                      + record + bytes(27)]
        dev = FakeDevice(reads=reads)
        result = Controller(dev).set_peq(bands)
        self.assertTrue(all(r['verified'] for r in result))
        self.assertEqual(len(dev.writes), 22)
        self.assertEqual(dev.writes[0],
                         frame(OP_SET, CMD_PEQ_BAND, records[0]))
        self.assertEqual(dev.writes[10],
                         frame(OP_SET, 0x0A, bytes([0x09, 0, 0, 0])))
        self.assertEqual(dev.writes[11], frame(OP_SET, 0x01, b''))

    def test_rejects_wrong_band_count(self):
        with self.assertRaises(ValueError):
            Controller(FakeDevice()).set_peq([{'freq': 32}] * 9)


if __name__ == '__main__':
    unittest.main()
