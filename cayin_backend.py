import ctypes
from ctypes import wintypes
import hid
import struct
import time
import json

CAYIN_VID = 0x2D87
CAYIN_PID_U2 = 0x003B
CAYIN_PID_U1 = 0x003A
REPORT_ID = 75

CMD_GET_DEV_INFO   = 0x1001
CMD_SET_VOLUME     = 0x0002
CMD_GET_VOLUME     = 0x1002
CMD_SET_GAIN       = 0x0003
CMD_SET_WORK_MODE  = 0x0004
CMD_SET_OUT_MODE   = 0x0005
CMD_SET_PCM_FILTER = 0x0006
CMD_SET_SCREEN_OFF = 0x0007
CMD_SET_BALANCE    = 0x0008
CMD_SET_PEQ_BANDS  = 0x0100
CMD_GET_PEQ_BANDS  = 0x0101
CMD_SET_PEQ_ENABLE = 0x0102

class GUID(ctypes.Structure):
    _fields_ = [
        ('Data1', wintypes.DWORD),
        ('Data2', wintypes.WORD),
        ('Data3', wintypes.WORD),
        ('Data4', wintypes.BYTE * 8)
    ]
    def __init__(self, s):
        import uuid
        u = uuid.UUID(s)
        self.Data1 = u.time_low
        self.Data2 = u.time_mid
        self.Data3 = u.time_hi_version
        for i in range(8):
            self.Data4[i] = u.bytes[8+i]

CLSID_MMDeviceEnumerator = GUID('BCDE0395-E52F-467C-8E3D-C4579291692E')
IID_IMMDeviceEnumerator = GUID('A95664D2-9614-4F35-A746-DE8DB63617E6')
IID_IAudioEndpointVolume = GUID('5CDF2C82-841E-4546-9722-0CF74078229A')

class PROPERTYKEY(ctypes.Structure):
    _fields_ = [('fmtid', GUID), ('pid', wintypes.DWORD)]

PKEY_Device_FriendlyName = PROPERTYKEY(GUID('a45c254e-df1c-4efd-8020-67d146a850e0'), 14)

class PROPVARIANT(ctypes.Structure):
    _fields_ = [
        ('vt', wintypes.WORD),
        ('wReserved1', wintypes.WORD),
        ('wReserved2', wintypes.WORD),
        ('wReserved3', wintypes.WORD),
        ('pwszVal', wintypes.LPWSTR),
    ]

crc32Table = []
for i in range(256):
    c = i
    for j in range(8):
        c = (0xEDB88320 ^ (c >> 1)) if (c & 1) else (c >> 1)
    crc32Table.append(c)

def calc_crc32(data):
    crc = 0xFFFFFFFF
    for b in data:
        crc = (crc >> 8) ^ crc32Table[(crc ^ b) & 0xFF]
    return (crc ^ 0xFFFFFFFF) & 0xFFFFFFFF

class CayinRU3Controller:
    def __init__(self):
        self.hid_dev = None
        self.endpoint_vol = None
        self.connected = False
        self.dev_name = 'Cayin RU3'
        self.seq = 0
        self.ole32 = ctypes.windll.ole32
        self.ole32.CoInitialize(None)
        self.connect()

    def connect(self):
        self.connected = False
        # 1. Connect HID
        for pid in [CAYIN_PID_U2, CAYIN_PID_U1]:
            try:
                self.hid_dev = hid.device()
                self.hid_dev.open(CAYIN_VID, pid)
                self.hid_dev.set_nonblocking(1)
                self.connected = True
                self.dev_name = self.hid_dev.get_product_string() or 'Cayin RU3'
                print(f'[Backend] Opened Cayin RU3 HID (PID 0x{pid:04X})')
                break
            except Exception:
                self.hid_dev = None

        # 2. Connect CoreAudio Volume
        try:
            self._connect_coreaudio()
        except Exception as e:
            print('[Backend] CoreAudio init error:', e)

        return self.connected

    def _connect_coreaudio(self):
        pEnum = ctypes.c_void_p()
        self.ole32.CoCreateInstance(ctypes.byref(CLSID_MMDeviceEnumerator), None, 1, ctypes.byref(IID_IMMDeviceEnumerator), ctypes.byref(pEnum))
        vtable = ctypes.cast(ctypes.cast(pEnum, ctypes.POINTER(ctypes.c_void_p)).contents, ctypes.POINTER(ctypes.c_void_p))

        pDevices = ctypes.c_void_p()
        enum_endpoints_proto = ctypes.WINFUNCTYPE(ctypes.c_long, ctypes.c_void_p, ctypes.c_int, wintypes.DWORD, ctypes.POINTER(ctypes.c_void_p))
        enum_endpoints = enum_endpoints_proto(vtable[3])
        enum_endpoints(pEnum, 0, 1, ctypes.byref(pDevices))

        col_vtable = ctypes.cast(ctypes.cast(pDevices, ctypes.POINTER(ctypes.c_void_p)).contents, ctypes.POINTER(ctypes.c_void_p))
        get_count_proto = ctypes.WINFUNCTYPE(ctypes.c_long, ctypes.c_void_p, ctypes.POINTER(wintypes.UINT))
        get_count = get_count_proto(col_vtable[3])
        item_proto = ctypes.WINFUNCTYPE(ctypes.c_long, ctypes.c_void_p, wintypes.UINT, ctypes.POINTER(ctypes.c_void_p))
        get_item = item_proto(col_vtable[4])

        count = wintypes.UINT()
        get_count(pDevices, ctypes.byref(count))

        for i in range(count.value):
            pDev = ctypes.c_void_p()
            get_item(pDevices, i, ctypes.byref(pDev))
            dev_vtable = ctypes.cast(ctypes.cast(pDev, ctypes.POINTER(ctypes.c_void_p)).contents, ctypes.POINTER(ctypes.c_void_p))
            
            open_prop_proto = ctypes.WINFUNCTYPE(ctypes.c_long, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(ctypes.c_void_p))
            open_prop = open_prop_proto(dev_vtable[4])
            pStore = ctypes.c_void_p()
            open_prop(pDev, 0, ctypes.byref(pStore))
            
            name = 'Unknown'
            if pStore.value:
                store_vtable = ctypes.cast(ctypes.cast(pStore, ctypes.POINTER(ctypes.c_void_p)).contents, ctypes.POINTER(ctypes.c_void_p))
                get_val_proto = ctypes.WINFUNCTYPE(ctypes.c_long, ctypes.c_void_p, ctypes.POINTER(PROPERTYKEY), ctypes.POINTER(PROPVARIANT))
                get_val = get_val_proto(store_vtable[5])
                pv = PROPVARIANT()
                get_val(pStore, ctypes.byref(PKEY_Device_FriendlyName), ctypes.byref(pv))
                if pv.vt == 31: name = pv.pwszVal

            if 'cayin' in name.lower() or 'ru3' in name.lower():
                activate_proto = ctypes.WINFUNCTYPE(ctypes.c_long, ctypes.c_void_p, ctypes.POINTER(GUID), wintypes.DWORD, ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p))
                activate = activate_proto(dev_vtable[3])
                pEndpointVol = ctypes.c_void_p()
                res_act = activate(pDev, ctypes.byref(IID_IAudioEndpointVolume), 1, None, ctypes.byref(pEndpointVol))
                if res_act == 0 and pEndpointVol.value:
                    self.endpoint_vol = pEndpointVol
                    print(f'[Backend] Bound CoreAudio volume for \"{name}\"')
                    break

    def get_volume(self):
        if not self.endpoint_vol:
            return 70
        try:
            vol_vtable = ctypes.cast(ctypes.cast(self.endpoint_vol, ctypes.POINTER(ctypes.c_void_p)).contents, ctypes.POINTER(ctypes.c_void_p))
            get_vol_scalar_proto = ctypes.WINFUNCTYPE(ctypes.c_long, ctypes.c_void_p, ctypes.POINTER(ctypes.c_float))
            get_vol_scalar = get_vol_scalar_proto(vol_vtable[9])
            fVol = ctypes.c_float()
            get_vol_scalar(self.endpoint_vol, ctypes.byref(fVol))
            return int(round(fVol.value * 100))
        except Exception:
            return 70

    def set_volume(self, val):
        val = max(0, min(100, int(val)))
        # 1. Set Windows CoreAudio Endpoint Volume
        if self.endpoint_vol:
            try:
                vol_vtable = ctypes.cast(ctypes.cast(self.endpoint_vol, ctypes.POINTER(ctypes.c_void_p)).contents, ctypes.POINTER(ctypes.c_void_p))
                set_vol_scalar_proto = ctypes.WINFUNCTYPE(ctypes.c_long, ctypes.c_void_p, ctypes.c_float, ctypes.c_void_p)
                set_vol_scalar = set_vol_scalar_proto(vol_vtable[7])
                set_vol_scalar(self.endpoint_vol, float(val) / 100.0, None)
            except Exception as e:
                print('[Backend] CoreAudio set_volume error:', e)

        # 2. Send HID packet
        self.send_vendor_cmd(CMD_SET_VOLUME, struct.pack('<I', val))
        return val

    def set_mute(self, is_muted):
        if self.endpoint_vol:
            try:
                vol_vtable = ctypes.cast(ctypes.cast(self.endpoint_vol, ctypes.POINTER(ctypes.c_void_p)).contents, ctypes.POINTER(ctypes.c_void_p))
                set_mute_proto = ctypes.WINFUNCTYPE(ctypes.c_long, ctypes.c_void_p, wintypes.BOOL, ctypes.c_void_p)
                set_mute = set_mute_proto(vol_vtable[14])
                set_mute(self.endpoint_vol, 1 if is_muted else 0, None)
            except Exception as e:
                print('[Backend] CoreAudio set_mute error:', e)
        return is_muted

    def build_packet(self, cmd, payload=b''):
        magic = b'BUXX'
        seq = (self.seq) & 0xFF
        self.seq = (self.seq + 1) & 0xFF
        flag = 0
        length = len(payload)
        head_raw = magic + struct.pack('<HBBH', cmd, seq, flag, length)
        head_crc = calc_crc32(head_raw)
        pkt = head_raw + struct.pack('<I', head_crc)
        if length > 0:
            body_crc = calc_crc32(payload)
            pkt += payload + struct.pack('<I', body_crc)
        return pkt

    def send_vendor_cmd(self, cmd, payload=b''):
        if not self.hid_dev:
            return False
        try:
            pkt = self.build_packet(cmd, payload)
            buf = bytes([REPORT_ID]) + pkt + bytes(max(0, 64 - len(pkt) - 1))
            self.hid_dev.write(buf[:64])
            return True
        except Exception as e:
            print(f'[Backend] send_vendor_cmd (0x{cmd:04X}) error:', e)
            return False

    def set_gain(self, level):
        is_high = 1 if level.upper() == 'HIGH' else 0
        return self.send_vendor_cmd(CMD_SET_GAIN, bytes([is_high]))

    def set_work_mode(self, mode):
        is_hyp = 1 if mode.upper() == 'HYP' else 0
        return self.send_vendor_cmd(CMD_SET_WORK_MODE, bytes([is_hyp]))

    def set_output_mode(self, mode):
        is_lo = 1 if mode.upper() == 'LO' else 0
        return self.send_vendor_cmd(CMD_SET_OUT_MODE, bytes([is_lo]))

    def set_pcm_filter(self, filter_num):
        return self.send_vendor_cmd(CMD_SET_PCM_FILTER, bytes([int(filter_num)]))

    def set_screen_timeout(self, seconds):
        return self.send_vendor_cmd(CMD_SET_SCREEN_OFF, bytes([int(seconds)]))

    def sync_peq(self, bands, master_enabled=True):
        # 10 bands * 8 bytes
        peq_payload = bytearray(80)
        filter_types = {
            'PEAK': 0, 'LOW_SHELF': 1, 'HIGH_SHELF': 2, 'LOW_PASS': 3,
            'HIGH_PASS': 4, 'BAND_PASS': 5, 'NOTCH': 6, 'ALL_PASS': 7
        }
        for i, b in enumerate(bands[:10]):
            offset = i * 8
            freq = int(b.get('freq', 1000))
            gain = float(b.get('gain', 0.0))
            gain88 = int(round(gain * 256))
            q_val = int(round(float(b.get('q', 1.41)) * 100))
            t_byte = filter_types.get(b.get('type', 'PEAK'), 0)
            enabled = 1 if b.get('enabled', True) else 0

            struct.pack_into('<HhHBB', peq_payload, offset, freq, gain88, q_val, t_byte, enabled)

        self.send_vendor_cmd(CMD_SET_PEQ_BANDS, bytes(peq_payload))
        self.send_vendor_cmd(CMD_SET_PEQ_ENABLE, bytes([1 if master_enabled else 0]))
        return True
