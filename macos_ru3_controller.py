import hid
import struct
import time

CAYIN_VID = 0x2D87
CAYIN_PID_U2 = 0x003B
CAYIN_PID_U1 = 0x003A
REPORT_ID = 75

crc32_table = []
for i in range(256):
    c = i
    for _ in range(8):
        c = (0xEDB88320 ^ (c >> 1)) if (c & 1) else (c >> 1)
    crc32_table.append(c)

def calc_crc32(data: bytes) -> int:
    crc = 0xFFFFFFFF
    for b in data:
        crc = (crc >> 8) ^ crc32_table[(crc ^ b) & 0xFF]
    return (crc ^ 0xFFFFFFFF) & 0xFFFFFFFF

class CayinRU3MacOS:
    def __init__(self):
        self.dev = hid.device()
        try:
            self.dev.open(CAYIN_VID, CAYIN_PID_U2)
        except Exception:
            self.dev.open(CAYIN_VID, CAYIN_PID_U1)
            
        self.dev.set_nonblocking(1)
        self.seq = 0
        prod = self.dev.get_product_string() or "Cayin RU3"
        print(f"[macOS] Connected to {prod} (VID 0x2D87:PID 0x{CAYIN_PID_U2:04X})!")

    def _build_packet(self, cmd: int, payload: bytes = b'') -> bytes:
        magic = b'BUXX'
        seq = (self.seq) & 0xFF
        self.seq = (self.seq + 1) & 0xFF
        flag = 0
        length = len(payload)
        
        # 10-byte header
        head_raw = magic + struct.pack('<HBBH', cmd, seq, flag, length)
        head_crc = calc_crc32(head_raw)
        pkt = head_raw + struct.pack('<I', head_crc)
        
        if length > 0:
            body_crc = calc_crc32(payload)
            pkt += payload + struct.pack('<I', body_crc)
        return pkt

    def send_cmd(self, cmd: int, payload: bytes = b''):
        pkt = self._build_packet(cmd, payload)
        buf = bytes([REPORT_ID]) + pkt + bytes(max(0, 64 - len(pkt) - 1))
        self.dev.write(buf[:64])
        time.sleep(0.02)
        resp = self.dev.read(64)
        if resp:
            print(f"  RX [CMD 0x{cmd:04X}]: {bytes(resp).hex(' ')}")
        return resp

    def set_volume(self, val: int):
        """Sets physical OLED volume on DAC (0 to 100)."""
        val = max(0, min(100, int(val)))
        print(f"[macOS] Sending Hardware Volume -> {val}")
        return self.send_cmd(0x0002, struct.pack('<I', val))

    def set_gain(self, high_gain: bool):
        """False = Low Gain (0dB), True = High Gain (+12dB)."""
        print(f"[macOS] Sending Gain -> {'HIGH' if high_gain else 'LOW'}")
        return self.send_cmd(0x0003, bytes([1 if high_gain else 0]))

    def set_work_mode(self, hyper_mode: bool):
        """False = STD, True = HYP (Hyper Turbo)."""
        print(f"[macOS] Sending Work Mode -> {'HYP' if hyper_mode else 'STD'}")
        return self.send_cmd(0x0004, bytes([1 if hyper_mode else 0]))

    def set_output_mode(self, line_out: bool):
        """False = PO (Headphone), True = LO (Line-Level)."""
        print(f"[macOS] Sending Output Mode -> {'LO' if line_out else 'PO'}")
        return self.send_cmd(0x0005, bytes([1 if line_out else 0]))

    def set_pcm_filter(self, filter_num: int):
        """1 to 7 ESS ES9069Q Digital Filter."""
        print(f"[macOS] Sending PCM Filter -> Filter {filter_num}")
        return self.send_cmd(0x0006, bytes([int(filter_num)]))

    def set_screen_timeout(self, seconds: int):
        """0, 15, 30, 60, 120 seconds."""
        print(f"[macOS] Sending Screen Timeout -> {seconds}s")
        return self.send_cmd(0x0007, bytes([int(seconds)]))

    def set_peq_10band(self, bands: list, master_enabled: bool = True):
        """
        bands: list of 10 dicts:
        [{'freq': 1000, 'gain': 2.5, 'q': 1.41, 'type': 0, 'enabled': 1}, ...]
        """
        payload = bytearray(80)
        for i, b in enumerate(bands[:10]):
            offset = i * 8
            freq = int(b.get('freq', 1000))
            gain88 = int(round(float(b.get('gain', 0.0)) * 256))
            q100 = int(round(float(b.get('q', 1.41)) * 100))
            t = int(b.get('type', 0))
            en = 1 if b.get('enabled', True) else 0
            struct.pack_into('<HhHBB', payload, offset, freq, gain88, q100, t, en)
            
        print(f"[macOS] Sending 10-Band PEQ (Master: {master_enabled})...")
        self.send_cmd(0x0100, bytes(payload))
        self.send_cmd(0x0102, bytes([1 if master_enabled else 0]))

if __name__ == '__main__':
    try:
        ru3 = CayinRU3MacOS()
        print("\n--- Testing Cayin RU3 Hardware Control on macOS ---")
        ru3.set_volume(70)
        time.sleep(0.1)
        ru3.set_gain(True)
        time.sleep(0.1)
        ru3.set_work_mode(True)
        time.sleep(0.1)
        ru3.set_pcm_filter(1)
        print("\nTest commands sent successfully!")
    except Exception as e:
        print("Error connecting to Cayin RU3:", e)
