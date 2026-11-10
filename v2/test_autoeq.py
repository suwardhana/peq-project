"""Tests for v2/web/autoeq.js, executed with node. Skips when node is missing.

Run: .\\.venv\\Scripts\\python.exe v2/test_autoeq.py
"""
import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

AUTOEQ_JS = str(Path(__file__).resolve().parent / 'web' / 'autoeq.js')

USER_SAMPLE = """Preamp: -1.9 dB
Filter 1: ON PK Fc 35 Hz Gain -0.6 dB Q 1.200
Filter 2: ON PK Fc 160 Hz Gain 1.9 dB Q 0.900
Filter 3: ON PK Fc 590 Hz Gain 1.6 dB Q 1.500
Filter 4: ON PK Fc 1100 Hz Gain -0.9 dB Q 2.000
Filter 5: ON PK Fc 2100 Hz Gain 3.6 dB Q 2.000
Filter 6: ON PK Fc 3400 Hz Gain -5.9 dB Q 1.300
Filter 7: ON PK Fc 5300 Hz Gain 2.7 dB Q 2.000
Filter 8: ON PK Fc 7900 Hz Gain -7.0 dB Q 2.000
Filter 9: ON PK Fc 10000 Hz Gain 6.6 dB Q 2.000
Filter 10: ON PK Fc 14000 Hz Gain -10.1 dB Q 2.000"""

DRIVER = """const fs = require('fs');
const { parseAutoEq } = require(process.argv[2]);
const cases = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
const get = (o, p) => p.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
const out = cases.map((c) => {
  try {
    const r = parseAutoEq(c.text, c.opts || {});
    if (c.expectError)
      return { name: c.name, ok: false, detail: 'expected error, got success' };
    const fails = Object.entries(c.expect || {})
      .filter(([p, w]) => JSON.stringify(get(r, p)) !== JSON.stringify(w))
      .map(([p, w]) => p + ': got ' + JSON.stringify(get(r, p)) +
                        ', want ' + JSON.stringify(w));
    return { name: c.name, ok: !fails.length, detail: fails.join('; ') };
  } catch (e) {
    if (c.expectError)
      return { name: c.name,
               ok: String(e.message).includes(c.expectError),
               detail: e.message };
    return { name: c.name, ok: false, detail: 'threw: ' + e.message };
  }
});
console.log(JSON.stringify(out));
"""

CASES = [
    {'name': 'user sample folded', 'text': USER_SAMPLE, 'opts': {},
     'expect': {
         'bands.length': 10, 'folded': True, 'preampDb': -1.9,
         'warnings.length': 0,
         'bands.0.freq': 35, 'bands.0.gain': -2.5, 'bands.0.q': 1.2,
         'bands.0.type': 'PEAK',
         'bands.1.gain': 0, 'bands.4.gain': 1.7, 'bands.5.gain': -7.8,
         'bands.8.gain': 4.7, 'bands.9.freq': 14000, 'bands.9.gain': -12}},
    {'name': 'user sample no fold', 'text': USER_SAMPLE,
     'opts': {'foldPreamp': False},
     'expect': {'folded': False, 'sawPreamp': True, 'preampDb': -1.9,
                'bands.0.gain': -0.6, 'bands.9.gain': -10.1}},
    {'name': 'types off pad',
     'text': ('Filter 1: ON LS Fc 100 Hz Gain 3 dB Q 0.7\n'
              'Filter 2: OFF PK Fc 200 Hz Gain 9 dB Q 1\n'
              'Filter 3: ON HS Fc 8000 Hz Gain -2 dB Q 1\n'
              'Filter 4: ON HP Fc 30 Hz Gain 0 dB Q 0.7'),
     'opts': {},
     'expect': {'bands.length': 10, 'folded': False,
                'bands.0.type': 'LSHELF', 'bands.1.type': 'BYPASS',
                'bands.1.gain': 0, 'bands.2.type': 'HSHELF',
                'bands.3.type': 'HPF', 'bands.4.type': 'BYPASS',
                'bands.9.type': 'BYPASS'}},
    {'name': 'eleven filters',
     'text': '\n'.join('Filter %d: ON PK Fc 1000 Hz Gain 0 dB Q 1' % i
                       for i in range(1, 12)),
     'opts': {}, 'expectError': 'device has 10 bands'},
    {'name': 'garbage', 'text': 'hello world\nLow shelf +3dB?',
     'opts': {}, 'expectError': 'not a Preamp/Filter line'},
    {'name': 'empty', 'text': '   \n# comment only\n',
     'opts': {}, 'expectError': 'no "Filter N'},
    {'name': 'clamps',
     'text': 'Filter 1: ON PK Fc 10 Hz Gain 20 dB Q 25',
     'opts': {},
     'expect': {'bands.0.freq': 20, 'bands.0.q': 10, 'bands.0.gain': 12,
                'warnings.length': 3}},
    {'name': 'bad type on',
     'text': 'Filter 1: ON XX Fc 100 Hz Gain 1 dB Q 1',
     'opts': {}, 'expectError': 'unsupported type'},
    {'name': 'bad type off ok',
     'text': 'Filter 1: OFF XX Fc 100 Hz Gain 1 dB Q 1',
     'opts': {}, 'expect': {'bands.0.type': 'BYPASS'}},
    {'name': 'no preamp',
     'text': 'Filter 1: ON PK Fc 500 Hz Gain 2.5 dB Q 1.4',
     'opts': {},
     'expect': {'sawPreamp': False, 'folded': False, 'preampDb': 0,
                'bands.0.gain': 2.5}},
]


@unittest.skipUnless(shutil.which('node'), 'node not available')
class AutoEqTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with tempfile.TemporaryDirectory() as tmp:
            driver = Path(tmp) / 'driver.cjs'
            cases = Path(tmp) / 'cases.json'
            driver.write_text(DRIVER, encoding='utf-8')
            cases.write_text(json.dumps(CASES), encoding='utf-8')
            proc = subprocess.run(
                ['node', str(driver), AUTOEQ_JS, str(cases)],
                capture_output=True, text=True, timeout=60)
        assert proc.returncode == 0, 'node driver failed: %s' % proc.stderr
        cls.results = {r['name']: r for r in json.loads(proc.stdout)}

    def test_cases(self):
        for case in CASES:
            with self.subTest(case['name']):
                result = self.results[case['name']]
                self.assertTrue(result['ok'], result['detail'])


if __name__ == '__main__':
    unittest.main(verbosity=2)
