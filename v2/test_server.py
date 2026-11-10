import http.client
import json
import threading
import unittest
from http.server import ThreadingHTTPServer

import server
from dac import CMD_PEQ_BAND, OP_SET, TransportError, encode_band


def rx(cmd, data=b'\x00'):
    data = bytes(data)
    return bytes([0x4B, 0x80, cmd, 0x00]) + data + bytes(60 - len(data))


class FakeDevice:
    def __init__(self, reads=()):
        self.reads = list(reads)
        self.writes = []
        self.closed = False

    def read(self, size, timeout_ms=None):
        return self.reads.pop(0) if self.reads else []

    def write(self, packet):
        self.writes.append(bytes(packet))
        return 64

    def close(self):
        self.closed = True


INFO = {'product_string': 'Cayin RU3 (U2)', 'product_id': 0x3B}

STATE_READS = [[], rx(0x23, b'\x5a'), [], rx(0x03, b'\x00'),
               [], rx(0x22, b'\x00'), [], rx(0x21, b'\x01'),
               [], rx(0x1A, b'\x09'), [], rx(0x1E, b'\x01'),
               [], rx(0x11, b'\x00'), [], rx(0x16, b'\x00'),
               [], rx(0x1F, b'\x05'), [], rx(0x20, b'\x06'),
               [], rx(0x24, b'\x00'), [], rx(0x0C, b'V1.0.3')]


class ServerTests(unittest.TestCase):
    def setUp(self):
        self._opener = server.opener
        self.httpd = ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        self.port = self.httpd.server_address[1]
        self.thread = threading.Thread(target=self.httpd.serve_forever,
                                       daemon=True)
        self.thread.start()

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        server.opener = self._opener

    def fake(self, reads=()):
        dev = FakeDevice(reads)
        server.opener = lambda: (dev, INFO)
        return dev

    def request(self, method, path, body=None):
        conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=10)
        data = json.dumps(body).encode() if body is not None else None
        headers = {'Content-Type': 'application/json'} if data else {}
        conn.request(method, path, body=data, headers=headers)
        response = conn.getresponse()
        payload = response.read().decode()
        try:
            return response.status, json.loads(payload)
        except ValueError:
            return response.status, payload

    def test_state(self):
        self.fake(list(STATE_READS))
        code, obj = self.request('GET', '/api/state')
        self.assertEqual(code, 200)
        self.assertTrue(obj['connected'])
        self.assertEqual(obj['volume'], 90)
        self.assertEqual(obj['gain_label'], 'LOW')
        self.assertEqual(obj['firmware'], 'V1.0.3')

    def test_state_disconnected(self):
        server.opener = lambda: (_ for _ in ()).throw(
            TransportError('no device'))
        code, obj = self.request('GET', '/api/state')
        self.assertEqual(code, 503)
        self.assertFalse(obj['connected'])

    def test_volume(self):
        dev = self.fake([[], [], rx(0x23, b'\x55')])
        code, obj = self.request('POST', '/api/volume', {'value': 85})
        self.assertEqual(code, 200)
        self.assertTrue(obj['verified'])
        self.assertEqual(dev.writes[0][:5], bytes([0x4B, OP_SET, 0x23, 1, 85]))

    def test_volume_rejects_bad_input(self):
        self.fake()
        for body in ({'value': 101}, {'value': 'x'}, {}):
            code, _ = self.request('POST', '/api/volume', body)
            self.assertEqual(code, 400, body)

    def test_setting(self):
        dev = self.fake([[], [], rx(0x03, b'\x01')])
        code, obj = self.request('POST', '/api/setting',
                                 {'key': 'gain', 'value': 1})
        self.assertEqual(code, 200)
        self.assertEqual(obj['readback'], 1)
        self.assertEqual(dev.writes[0][:5], bytes([0x4B, OP_SET, 3, 1, 1]))

    def test_setting_rejects_unknown(self):
        self.fake()
        code, _ = self.request('POST', '/api/setting',
                               {'key': 'mute', 'value': 1})
        self.assertEqual(code, 400)

    def test_peq_roundtrip(self):
        bands = [{'freq': 32 + i, 'q': 0.71, 'gain': 0.0, 'type': 'PEAK'}
                 for i in range(10)]
        records = [encode_band(i, b['freq'], b['q'], b['gain'], b['type'])
                   for i, b in enumerate(bands)]
        reads = [[]] * 12
        for record in records:
            reads += [[], bytes([0x4B, 0x80, CMD_PEQ_BAND, 0x21])
                      + record + bytes(27)]
        self.fake(reads)
        code, obj = self.request('POST', '/api/peq', {'bands': bands})
        self.assertEqual(code, 200)
        self.assertTrue(all(r['verified'] for r in obj['bands']))

    def test_peq_rejects_bad_input(self):
        self.fake()
        code, _ = self.request('POST', '/api/peq', {'bands': []})
        self.assertEqual(code, 400)
        code, _ = self.request('POST', '/api/peq', {})
        self.assertEqual(code, 400)

    def test_index_served(self):
        code, body = self.request('GET', '/')
        self.assertEqual(code, 200)
        self.assertIn('RU3', body)

    def test_static_js_served(self):
        code, body = self.request('GET', '/app.js')
        self.assertEqual(code, 200)
        self.assertIn('fetch', body)

    def test_unknown_path(self):
        code, _ = self.request('GET', '/nope')
        self.assertEqual(code, 404)


if __name__ == '__main__':
    unittest.main()
