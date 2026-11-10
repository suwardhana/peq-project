"""USER_GEQ protocol regression tests, including real OEM golden packets."""
from collections import deque
import http.client
import json
from pathlib import Path
import struct
import threading
import unittest
from unittest.mock import patch
from http.server import ThreadingHTTPServer

from capture_geq import parse_packets
from dac import (CMD_COMMIT, CMD_EQ_PRESET, CMD_FIRMWARE, CMD_PEQ_APPLY,
                 CMD_PEQ_BAND, GEQ_FREQS, GEQ_Q, OP_GET, OP_SET, USER_GEQ,
                 USER_PEQ, Controller, TransportError, band_query_payload,
                 decode_band, encode_band, frame)
import server


class MemoryDevice:
    """HID stand-in with separate preset banks and optional dropped writes."""
    def __init__(self):
        self.banks = {
            preset: [encode_band(i, freq, GEQ_Q, 0, 'PEAK', preset)
                     for i, freq in enumerate(GEQ_FREQS)]
            for preset in (USER_GEQ, USER_PEQ)
        }
        self.banks[USER_PEQ][0] = encode_band(0, 29, 0.6, -1.8, 'PEAK')
        self.settings = {CMD_EQ_PRESET: USER_PEQ}
        self.writes = []
        self.replies = deque()
        self.drop = {}
        self.reply_override = None
        self.closed = False

    def read(self, size, timeout_ms=None):
        return self.replies.popleft() if self.replies else []

    def write(self, packet):
        packet = bytes(packet)
        self.writes.append(packet)
        _, opcode, cmd, length = packet[:4]
        data = packet[4:4 + length]
        if opcode == OP_GET:
            if cmd == CMD_PEQ_BAND:
                back = self.reply_override or self.banks[data[0]][data[1]]
            elif cmd == CMD_FIRMWARE:
                back = b'V1.0.3\0'
            else:
                back = bytes([self.settings.get(cmd, 0)])
            self.replies.append(bytes([0x4B, OP_GET, cmd, length])
                                + back + bytes(60 - len(back)))
        elif cmd == CMD_PEQ_BAND:
            key = (data[0], data[1])
            if self.drop.get(key, 0):
                self.drop[key] -= 1
            else:
                self.banks[data[0]][data[1]] = data
        elif cmd not in (CMD_COMMIT, CMD_PEQ_APPLY):
            self.settings[cmd] = data[0]
        return len(packet)

    def close(self):
        self.closed = True


class GoldenTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        raw = (Path(__file__).parent / 'captures/geq_custom.txt').read_text()
        cls.packets = parse_packets(raw)

    def test_queries_match_oem_and_keep_peq_default(self):
        queries = [bytes.fromhex(p['packet_hex']) for p in self.packets
                   if p['direction'] == 'tx' and p['opcode'] == OP_GET
                   and p['command'] == CMD_PEQ_BAND
                   and bytes.fromhex(p['data_hex'])[0] == USER_GEQ]
        self.assertGreaterEqual(len(queries), 10)
        for packet in queries:
            self.assertEqual(frame(OP_GET, CMD_PEQ_BAND,
                                   band_query_payload(packet[5], USER_GEQ)),
                             packet)
        self.assertEqual(band_query_payload(0)[0], USER_PEQ)

    def test_coefficients_and_metadata_match_positive_negative_and_flat_oem(self):
        records = [bytes.fromhex(p['data_hex'])[:33] for p in self.packets
                   if p['command'] == CMD_PEQ_BAND
                   and bytes.fromhex(p['data_hex'])[0] == USER_GEQ
                   and (p['direction'] == 'rx' or p['opcode'] == OP_SET)]
        gains = set()
        for record in records:
            b = decode_band(record, USER_GEQ)
            gains.add(b['gain_db'])
            self.assertEqual(b['freq'], GEQ_FREQS[b['band']])
            mine = encode_band(b['band'], b['freq'], GEQ_Q, b['gain_db'],
                               'PEAK', USER_GEQ)
            self.assertEqual(mine[:4], record[:4])
            self.assertEqual(mine[24:], record[24:])
            for actual, expected in zip(struct.unpack('<5I', mine[4:24]),
                                        struct.unpack('<5I', record[4:24])):
                self.assertLessEqual(abs(actual - expected), 1, b)
        self.assertTrue({-0.5, 0, 0.5, 1}.issubset(gains))


class ControllerGeqTests(unittest.TestCase):
    def setUp(self):
        self.dev = MemoryDevice()
        self.controller = Controller(self.dev)
        self.sleep = patch('dac.time.sleep').start()
        self.addCleanup(patch.stopall)

    def test_read_inactive_geq_does_not_change_active_preset_or_peq(self):
        before = list(self.dev.banks[USER_PEQ])
        data = self.controller.get_geq()
        self.assertEqual(data['preset'], 8)
        self.assertEqual(data['frequencies'], list(GEQ_FREQS))
        self.assertEqual(len(data['bands']), 10)
        self.assertEqual(data['q'], .71)
        self.assertTrue(all(p[1] == OP_GET for p in self.dev.writes))
        self.assertEqual(self.dev.settings[CMD_EQ_PRESET], USER_PEQ)
        self.assertEqual(self.dev.banks[USER_PEQ], before)

    def test_full_save_applies_commits_and_verifies_without_switching_preset(self):
        before = list(self.dev.banks[USER_PEQ])
        gains = [-12, -6, -.5, 0, .1, .5, 1, 3, 6, 12]
        self.assertTrue(all(r['verified'] for r in self.controller.set_geq(gains)))
        self.assertEqual([p[2] for p in self.dev.writes],
                         [CMD_PEQ_BAND] * 10 + [CMD_PEQ_APPLY, CMD_COMMIT]
                         + [CMD_PEQ_BAND] * 10)
        self.assertEqual(self.dev.writes[10],
                         frame(OP_SET, CMD_PEQ_APPLY, b'\x08\x00\x00\x00'))
        self.assertEqual(self.dev.banks[USER_PEQ], before)
        self.assertEqual(self.dev.settings[CMD_EQ_PRESET], USER_PEQ)
        readback = self.controller.get_geq()['bands']
        for b, gain in zip(readback, gains):
            self.assertAlmostEqual(b['gain_db'], gain, delta=1/256)

    def test_invalid_input_is_rejected_before_any_write(self):
        for gains in (None, {}, [], [0] * 9, [0] * 11, '0' * 10):
            with self.assertRaises(ValueError):
                self.controller.set_geq(gains)
        for bad in (True, None, '1', float('nan'), float('inf'), -12.1, 12.1):
            with self.assertRaises(ValueError):
                self.controller.set_geq([0] * 9 + [bad])
        self.assertEqual(self.dev.writes, [])

    def test_retries_only_dropped_band(self):
        self.dev.drop[(USER_GEQ, 3)] = 1
        result = self.controller.set_geq([1] * 10)
        self.assertTrue(all(r['verified'] for r in result))
        writes = [p[5] for p in self.dev.writes
                  if p[1:3] == bytes([OP_SET, CMD_PEQ_BAND])]
        self.assertEqual(writes, list(range(10)) + [3])

    def test_persistent_failure_reports_unverified_after_three_attempts(self):
        self.dev.drop[(USER_GEQ, 5)] = -1
        result = self.controller.set_geq([1] * 10)
        self.assertEqual([r['band'] for r in result if not r['verified']], [5])
        self.assertEqual(sum(p[1:3] == bytes([OP_SET, CMD_PEQ_APPLY])
                             for p in self.dev.writes), 3)

    def test_rejects_reply_for_other_bank_or_band(self):
        for record in (self.dev.banks[USER_PEQ][0],
                       self.dev.banks[USER_GEQ][1]):
            self.dev.reply_override = record
            with self.assertRaises(TransportError):
                self.controller.get_geq()


class GeqApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.original_opener = server.opener
        cls.httpd = ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        server.opener = cls.original_opener

    def setUp(self):
        self.dev = MemoryDevice()
        server.opener = lambda: (self.dev, {'product_string': 'test RU3',
                                          'product_id': 0x3B})
        patch('dac.time.sleep').start()
        self.addCleanup(patch.stopall)

    def request(self, method, path, body=None):
        conn = http.client.HTTPConnection('127.0.0.1', self.httpd.server_port)
        try:
            conn.request(method, path, json.dumps(body) if body is not None else None,
                         {'Content-Type': 'application/json'})
            response = conn.getresponse()
            return response.status, json.loads(response.read())
        finally:
            conn.close()

    def test_geq_roundtrip_and_peq_bank_is_preserved(self):
        before = list(self.dev.banks[USER_PEQ])
        code, result = self.request('POST', '/api/geq', {'gains': [.5] * 10})
        self.assertEqual(code, 200)
        self.assertEqual(result['preset'], 8)
        self.assertTrue(all(b['verified'] for b in result['bands']))
        code, data = self.request('GET', '/api/geq')
        self.assertEqual(code, 200)
        self.assertEqual([b['gain_db'] for b in data['bands']], [.5] * 10)
        self.assertEqual(self.dev.banks[USER_PEQ], before)
        self.assertTrue(self.dev.closed)

    def test_invalid_geq_request_returns_400_without_writes(self):
        for body in ({}, {'gains': []}, {'gains': [0] * 9 + [True]},
                     {'gains': [0] * 9 + [13]}, [0] * 10):
            code, _ = self.request('POST', '/api/geq', body)
            self.assertEqual(code, 400, body)
        self.assertEqual(self.dev.writes, [])

    def test_failed_verification_returns_500(self):
        self.dev.drop[(USER_GEQ, 1)] = -1
        code, data = self.request('POST', '/api/geq', {'gains': [1] * 10})
        self.assertEqual(code, 500)
        self.assertFalse(data['bands'][1]['verified'])

    def test_disconnected_get_and_post_return_503(self):
        def missing():
            raise TransportError('DAC not connected')
        server.opener = missing
        for method, body in (('GET', None), ('POST', {'gains': [0] * 10})):
            code, data = self.request(method, '/api/geq', body)
            self.assertEqual(code, 503)
            self.assertFalse(data['connected'])

    def test_eq8_selection_commits_and_verifies(self):
        code, result = self.request('POST', '/api/setting', {'key': 'eq', 'value': 8})
        self.assertEqual(code, 200)
        self.assertTrue(result['verified'])
        self.assertEqual(result['readback'], 8)
        self.assertEqual([p[2] for p in self.dev.writes],
                         [CMD_EQ_PRESET, CMD_COMMIT, CMD_EQ_PRESET])


if __name__ == '__main__':
    unittest.main()
