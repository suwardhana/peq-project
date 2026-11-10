"""Protocol Micro local control server: JSON API + static web UI, stdlib only.

Start:  .venv/bin/python v3/server.py [--port 8766]
Then open http://127.0.0.1:8766 in a browser.

API (JSON):
  GET  /api/state             device identity + firmware + pregain + slot
  GET  /api/peq               8 decoded bands (+ pregain, slot)
  POST /api/peq               {"bands": [{freq,q,gain,type} x8], "pregain": dB}
                              -> write, flash, per-band read-back verify
  POST /api/pregain           {"value": -12..0}
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import errno
import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent))
from micro import BAND_COUNT, Controller, TransportError, open_device

opener = open_device  # tests override this with a fake

WEB_DIR = Path(__file__).resolve().parent / 'web'
MIME = {'.html': 'text/html; charset=utf-8',
        '.js': 'text/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.json': 'application/json'}

# hidapi's macOS backend calls IOHIDManager from hid.enumerate(), which is not
# thread safe — two request threads enumerating at once crash the process with
# SIGSEGV.  Every HID touch therefore runs on one dedicated worker thread; the
# HTTP threads only wait for the result.
hid_worker = ThreadPoolExecutor(max_workers=1, thread_name_prefix='hid')


def _run(func, args):
    device, info = opener()
    try:
        return func(Controller(device), info, *args)
    finally:
        device.close()


def with_device(func, *args):
    return hid_worker.submit(_run, func, args).result(timeout=30)


def read_state(controller, info):
    state = controller.read_state()
    state.update(product=info.get('product_string'),
                 product_id='0x%04x' % info['product_id'],
                 connected=True)
    return state


class Handler(BaseHTTPRequestHandler):
    server_version = 'Microv3/1.0'

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
            return json.loads(raw.decode('utf-8') or '{}')
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
            if path == '/api/pregain':
                if 'value' not in body:
                    return self._json(400, {'error': 'missing value'})
                return self._json(200, with_device(
                    lambda c, i: c.set_pregain(body['value'])))
            if path == '/api/peq':
                bands = body.get('bands')
                if bands is None:
                    return self._json(400, {'error': 'missing bands'})
                if not isinstance(bands, list) or len(bands) != BAND_COUNT:
                    return self._json(
                        400, {'error': 'bands must be a list of exactly %d'
                                       % BAND_COUNT})
                result = with_device(
                    lambda c, i: c.set_peq(bands, body.get('pregain')))
                ok = all(r.get('verified') for r in result['bands'])
                if result.get('pregain'):
                    ok = ok and result['pregain'].get('verified')
                return self._json(200 if ok else 500, result)
            return self._json(404, {'error': 'not found'})
        except ValueError as exc:
            return self._json(400, {'error': str(exc)})
        except (TransportError, OSError) as exc:
            return self._json(503, {'connected': False, 'error': str(exc)})

    def _api_get(self, path):
        try:
            if path == '/api/state':
                return self._json(200, with_device(read_state))
            if path == '/api/peq':
                return self._json(200, with_device(
                    lambda c, i: c.get_peq()))
            return self._json(404, {'error': 'not found'})
        except (TransportError, OSError) as exc:
            return self._json(503, {'connected': False, 'error': str(exc)})


def run(port):
    try:
        server = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    except OSError as exc:
        if exc.errno == errno.EADDRINUSE:
            print('Port %d is already in use — a v3 server is probably '
                  'already running.' % port, file=sys.stderr)
            print('Open http://127.0.0.1:%d , or stop the other instance:'
                  % port, file=sys.stderr)
            print('  lsof -ti tcp:%d | xargs kill' % port, file=sys.stderr)
            print('  ...or start this one on another port: '
                  'v3/server.py --port 8767', file=sys.stderr)
            raise SystemExit(2)
        raise
    print('Protocol Micro UI: http://127.0.0.1:%d  (Ctrl+C to stop)' % port)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\nStopped.')
    finally:
        hid_worker.shutdown(wait=False)
        server.server_close()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=8766)
    args = parser.parse_args(argv)
    run(args.port)


if __name__ == '__main__':
    main()
