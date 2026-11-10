"""HTTP API tests for the Protocol Micro server (no DAC required)."""
import http.client
import json
import threading
import unittest
from http.server import ThreadingHTTPServer

import server
from micro import BAND_COUNT, TransportError
from test_micro import CAPTURED, FakeDevice, TABLE


INFO = {'product_string': 'Protocol Micro', 'product_id': 0xC20F}


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

    def fake(self):
        device = FakeDevice(TABLE)
        server.opener = lambda: (device, INFO)
        return device

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
        self.fake()
        code, obj = self.request('GET', '/api/state')
        self.assertEqual(code, 200)
        self.assertTrue(obj['connected'])
        self.assertEqual(obj['firmware'], '0.2')
        self.assertEqual(obj['product'], 'Protocol Micro')
        self.assertEqual(len(obj['bands']), BAND_COUNT)

    def test_state_disconnected(self):
        server.opener = lambda: (_ for _ in ()).throw(
            TransportError('no device'))
        code, obj = self.request('GET', '/api/state')
        self.assertEqual(code, 503)
        self.assertFalse(obj['connected'])

    def test_peq_get(self):
        self.fake()
        code, obj = self.request('GET', '/api/peq')
        self.assertEqual(code, 200)
        self.assertEqual(len(obj['bands']), BAND_COUNT)
        self.assertEqual(obj['bands'][0]['freq'], 105)
        self.assertEqual(obj['bands'][0]['type_name'], 'BYPASS')

    def test_peq_post_verifies(self):
        self.fake()
        bands = [{'freq': freq, 'q': q, 'gain': gain, 'type': ftype}
                 for freq, q, gain, ftype, _ in CAPTURED]
        code, obj = self.request('POST', '/api/peq', {'bands': bands})
        self.assertEqual(code, 200)
        self.assertTrue(all(b['verified'] for b in obj['bands']))

    def test_peq_post_rejects_wrong_length(self):
        self.fake()
        for body in ({'bands': []}, {'bands': [{}] * 9}, {}):
            code, _ = self.request('POST', '/api/peq', body)
            self.assertEqual(code, 400, body)

    def test_peq_post_rejects_bad_type(self):
        self.fake()
        bands = [{'freq': 1000, 'q': 1, 'gain': 0, 'type': 'NOTCH'}] * 8
        code, obj = self.request('POST', '/api/peq', {'bands': bands})
        self.assertEqual(code, 400)
        self.assertIn('type', obj['error'])

    def test_pregain(self):
        device = self.fake()
        state = {'value': 0}
        original = device._reply_for

        def reply(packet):
            if packet[2] == 0x03:
                if packet[1] == 0x01:
                    state['value'] = packet[5]
                from test_micro import report
                return list(report(0x03, bytes([0x00, state['value']])))
            return original(packet)

        device._reply_for = reply
        code, obj = self.request('POST', '/api/pregain', {'value': -4})
        self.assertEqual(code, 200)
        self.assertTrue(obj['verified'])
        self.assertEqual(obj['readback'], -4)

    def test_pregain_rejects_bad_input(self):
        self.fake()
        for body in ({'value': 5}, {'value': -20}, {'value': 'x'}, {}):
            code, _ = self.request('POST', '/api/pregain', body)
            self.assertEqual(code, 400, body)

    def test_index_served(self):
        code, body = self.request('GET', '/')
        self.assertEqual(code, 200)
        self.assertIn('Protocol Micro', body)

    def test_static_js_served(self):
        code, body = self.request('GET', '/app.js')
        self.assertEqual(code, 200)
        self.assertIn('fetch', body)

    def test_unknown_path(self):
        code, _ = self.request('GET', '/nope')
        self.assertEqual(code, 404)


if __name__ == '__main__':
    unittest.main()
