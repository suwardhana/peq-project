"""RU3 v2 local control server: JSON API + static web UI, stdlib only.

Start:  .\\.venv\\Scripts\\python.exe v2/server.py [--port 8765]
Then open http://127.0.0.1:8765 in a browser.

API (JSON):
  GET  /api/state            full device state (503 when DAC missing)
  POST /api/volume           {"value": 0..100}
  POST /api/setting          {"key": gain|output|work_mode|eq|uac|filter,
                              "value": int}
  GET  /api/peq              10 decoded bands
  POST /api/peq              {"bands": [{freq,q,gain,type} x10]} -> per-band verify
  GET  /api/geq              USER_GEQ (preset 8), fixed frequencies + 10 bands
  POST /api/geq              {"gains": [10 x dB]} -> per-band verify
"""
import argparse
import json
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent))
from dac import CMD_FILTER, CMD_GAIN, CMD_OUTPUT, CMD_UAC, CMD_VOLUME, \
    CMD_WORK_MODE, CMD_EQ_PRESET, Controller, TransportError, open_device

opener = open_device  # tests override this with a fake

WEB_DIR = Path(__file__).resolve().parent / 'web'
MIME = {'.html': 'text/html; charset=utf-8',
        '.js': 'text/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.json': 'application/json'}
SETTINGS = {'gain': CMD_GAIN, 'output': CMD_OUTPUT,
            'work_mode': CMD_WORK_MODE, 'eq': CMD_EQ_PRESET, 'uac': CMD_UAC,
            'filter': CMD_FILTER}
lock = threading.Lock()


def with_device(func, *args):
    with lock:
        device, info = opener()
        try:
            return func(Controller(device), info, *args)
        finally:
            device.close()


def read_state(controller, info):
    state = controller.read_state()
    state.update(product=info['product_string'],
                 product_id='0x%04x' % info['product_id'])
    return state


class Handler(BaseHTTPRequestHandler):
    server_version = 'RU3v2/1.0'

    def log_message(self, *args):
        pass

    def _json(self, code, obj):
        body = json.dumps(obj).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        try:
            length = int(self.headers.get('Content-Length', 0))
        except ValueError:
            length = 0
        raw = self.rfile.read(length) if length else b''
        try:
            body = json.loads(raw.decode('utf-8') or '{}')
            if not isinstance(body, dict):
                raise ValueError('JSON body must be an object')
            return body
        except (ValueError, UnicodeDecodeError):
            raise ValueError('invalid JSON body')

    def do_GET(self):
        path = urlparse(self.path).path
        if path == '/':
            path = '/index.html'
        if path.startswith('/api/'):
            return self._api_get(path)
        target = (WEB_DIR / path.lstrip('/')).resolve()
        if WEB_DIR not in target.parents or not target.is_file():
            return self._json(404, {'error': 'not found'})
        data = target.read_bytes()
        self.send_response(200)
        self.send_header('Content-Type', MIME.get(target.suffix,
                                                 'application/octet-stream'))
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        path = urlparse(self.path).path
        if not path.startswith('/api/'):
            return self._json(404, {'error': 'not found'})
        try:
            body = self._body()
        except ValueError as exc:
            return self._json(400, {'error': str(exc)})
        try:
            if path == '/api/volume':
                if 'value' not in body:
                    return self._json(400, {'error': 'missing value'})
                result = with_device(
                    lambda c, i: c.set_volume(body['value']))
                return self._json(200, result)
            if path == '/api/setting':
                key, value = body.get('key'), body.get('value')
                if key not in SETTINGS:
                    return self._json(400, {'error': 'unknown setting: %r'
                                                     % (key,)})
                def apply(controller, info):
                    controller.set_u8(SETTINGS[key], value)
                    if key == 'uac':
                        # Device re-enumerates; no read-back possible here.
                        return {'key': key, 'sent': True,
                                'reconnecting': True}
                    if key == 'eq':
                        time.sleep(0.025)
                        controller.commit()
                    time.sleep(0.05)
                    readback = controller.get_u8(SETTINGS[key])
                    return {'key': key, 'readback': readback,
                            'verified': readback == value}
                return self._json(200, with_device(apply))
            if path == '/api/peq':
                if 'bands' not in body:
                    return self._json(400, {'error': 'missing bands'})
                result = with_device(lambda c, i: c.set_peq(body['bands']))
                code = 200 if all(r.get('verified') for r in result) else 500
                return self._json(code, {'bands': result})
            if path == '/api/geq':
                if 'gains' not in body:
                    return self._json(400, {'error': 'missing gains'})
                result = with_device(lambda c, i: c.set_geq(body['gains']))
                code = 200 if all(r.get('verified') for r in result) else 500
                return self._json(code, {'preset': 8, 'bands': result})
            return self._json(404, {'error': 'not found'})
        except ValueError as exc:
            return self._json(400, {'error': str(exc)})
        except (TransportError, OSError) as exc:
            return self._json(503, {'connected': False, 'error': str(exc)})

    def _api_get(self, path):
        try:
            if path == '/api/state':
                return self._json(200, {'connected': True,
                                        **with_device(read_state)})
            if path == '/api/peq':
                return self._json(200, {'bands': with_device(
                    lambda c, i: c.get_peq())})
            if path == '/api/geq':
                return self._json(200, with_device(lambda c, i: c.get_geq()))
            return self._json(404, {'error': 'not found'})
        except (TransportError, OSError) as exc:
            return self._json(503, {'connected': False, 'error': str(exc)})


def run(port):
    server = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    print('RU3 v2 UI: http://127.0.0.1:%d  (Ctrl+C to stop)' % port)
    server.serve_forever()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=8765)
    args = parser.parse_args(argv)
    run(args.port)


if __name__ == '__main__':
    main()
