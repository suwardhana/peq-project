"""Capture OEM USB logs without issuing DAC commands or clearing logcat.

Example (start before operating the Cayin app, Ctrl+C when finished):
    python3 v2/capture_geq.py --serial IP:PORT --label geq_slider

Decode an existing UTF-8/UTF-16 capture:
    python3 v2/capture_geq.py --input v2/captures/user_peq.txt

JSON records preserve the complete packet. Decoded header fields are transport
observations, not an inferred GEQ protocol or proof that a write took effect.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys


PACKET_LOG = re.compile(
    r'Data (sent successfully|received):\s*'
    r'((?:[0-9a-fA-F]{2}(?:\s+|$))+)')


def decode_text(raw):
    encoding = 'utf-16' if raw.startswith((b'\xff\xfe', b'\xfe\xff')) else 'utf-8-sig'
    return raw.decode(encoding, errors='replace')


def parse_packets(text):
    records = []
    for line_number, line in enumerate(text.splitlines(), 1):
        match = PACKET_LOG.search(line)
        if not match:
            continue
        packet = bytes.fromhex(match[2])
        if len(packet) < 4 or packet[0] != 0x4B:
            continue
        records.append({
            'line': line_number,
            'direction': 'tx' if match[1] == 'sent successfully' else 'rx',
            'opcode': packet[1],
            'command': packet[2],
            'declared_length': packet[3],
            'packet_bytes': len(packet),
            'packet_hex': packet.hex(),
            # Responses may echo length 0 and still contain data. Preserve
            # every byte after the header instead of slicing by that length.
            'data_hex': packet[4:].hex(),
        })
    return records


def summarize(raw, label, serial=None):
    return {
        'label': label,
        'serial': serial,
        'captured_at': datetime.now(timezone.utc).isoformat(),
        'source_sha256': hashlib.sha256(raw).hexdigest(),
        'packets': parse_packets(decode_text(raw)),
    }


def capture(serial, path, adb='adb'):
    """Stream the USB tag only; retain partial evidence on interruption."""
    command = [adb, '-s', serial, 'logcat', '-v', 'threadtime', '-T', '1',
               'UsbHidManager:D', '*:S']
    with path.open('xb') as output:
        process = subprocess.Popen(command, stdout=output)
        try:
            return process.wait()
        except KeyboardInterrupt:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
            return 0


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument('--serial', help='explicit ADB device serial or IP:port')
    source.add_argument('--input', type=Path, help='decode an existing log')
    parser.add_argument('--label', default='geq', help='name of the app action')
    parser.add_argument('--output', type=Path,
                        default=Path(__file__).resolve().parent / 'logs' / 'geq')
    parser.add_argument('--adb', default='adb')
    args = parser.parse_args(argv)
    args.output.mkdir(parents=True, exist_ok=True)
    label = re.sub(r'[^a-zA-Z0-9_-]', '_', args.label)
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    stem = args.output / (stamp + '_' + label)
    code = 0
    if args.input:
        raw = args.input.read_bytes()
    else:
        path = stem.with_suffix('.log')
        print('Recording UsbHidManager to %s' % path, flush=True)
        print('Operate the Cayin app, then Ctrl+C to save.', flush=True)
        code = capture(args.serial, path, args.adb)
        raw = path.read_bytes()
    result = summarize(raw, args.label, args.serial)
    path = stem.with_suffix('.json')
    with path.open('x', encoding='utf-8') as output:
        json.dump(result, output, indent=2)
        output.write('\n')
    print('%d packets: %s' % (len(result['packets']), path))
    if code:
        print('ADB exited with status %d; partial log retained.' % code,
              file=sys.stderr)
    return code


if __name__ == '__main__':
    sys.exit(main())
