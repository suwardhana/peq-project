"""Log parser checks against the OEM log format and saved USB evidence."""
from pathlib import Path
import unittest

from capture_geq import decode_text, parse_packets, summarize


class CaptureTests(unittest.TestCase):
    def test_preserves_reply_data_when_length_echo_is_zero(self):
        text = ('11-04 12:00:00.000 123 456 D UsbHidManager: '
                'Data received: 4B 80 1A 00 09 00 00 00\n')
        packet, = parse_packets(text)
        self.assertEqual(packet['direction'], 'rx')
        self.assertEqual(packet['declared_length'], 0)
        self.assertEqual(packet['data_hex'], '09000000')

    def test_only_parses_report_4b_successful_io(self):
        text = ('UsbHidManager: Data sent successfully: 4B 01 1A 01 09\n'
                'UsbHidManager: Failed to send data: 4B 01 1A 01 09\n'
                'UsbHidManager: Data received: 54 80 1A 00 09\n'
                'UsbHidManager: Data received: 4B 80\n')
        packet, = parse_packets(text)
        self.assertEqual(packet['direction'], 'tx')
        self.assertEqual(packet['packet_hex'], '4b011a0109')
        self.assertEqual(packet['line'], 1)

    def test_decodes_windows_and_utf8_logs(self):
        text = 'UsbHidManager: Data sent successfully: 4B 01 01 00\r\n'
        for encoding in ('utf-16', 'utf-8', 'utf-8-sig'):
            with self.subTest(encoding=encoding):
                self.assertEqual(decode_text(text.encode(encoding)), text)

    def test_saved_peq_preset_capture(self):
        raw = (Path(__file__).parent / 'captures' / 'user_peq.txt').read_bytes()
        result = summarize(raw, 'historical-peq')
        writes = [p for p in result['packets']
                  if p['direction'] == 'tx' and p['opcode'] == 1
                  and p['command'] == 0x1A]
        self.assertEqual(len(writes), 1)
        self.assertEqual(writes[0]['declared_length'], 1)
        self.assertTrue(writes[0]['data_hex'].startswith('09'))
        self.assertEqual(len(result['source_sha256']), 64)


if __name__ == '__main__':
    unittest.main()
