import os
import sys
import webview
import json
from cayin_backend import CayinRU3Controller

class Api:
    def __init__(self):
        self.controller = CayinRU3Controller()

    def get_initial_state(self):
        connected = self.controller.connect()
        vol = self.controller.get_volume()
        return {
            'connected': connected,
            'device_name': self.controller.dev_name,
            'volume': vol
        }

    def set_volume(self, val):
        new_vol = self.controller.set_volume(val)
        return {'success': True, 'volume': new_vol}

    def set_mute(self, is_muted):
        self.controller.set_mute(is_muted)
        return {'success': True, 'muted': is_muted}

    def set_gain(self, level):
        res = self.controller.set_gain(level)
        return {'success': res, 'gain': level}

    def set_work_mode(self, mode):
        res = self.controller.set_work_mode(mode)
        return {'success': res, 'work_mode': mode}

    def set_output_mode(self, mode):
        res = self.controller.set_output_mode(mode)
        return {'success': res, 'output_mode': mode}

    def set_pcm_filter(self, filter_id):
        res = self.controller.set_pcm_filter(filter_id)
        return {'success': res, 'pcm_filter': filter_id}

    def set_screen_timeout(self, seconds):
        res = self.controller.set_screen_timeout(seconds)
        return {'success': res, 'timeout': seconds}

    def sync_peq(self, bands, master_enabled=True):
        res = self.controller.sync_peq(bands, master_enabled)
        return {'success': res}

def main():
    api = Api()
    html_path = os.path.abspath(os.path.join(os.path.dirname(__file__), 'ui', 'index.html'))
    
    window = webview.create_window(
        title='Cayin RU3 Studio Deck — 10-Band Parametric EQ',
        url=f'file:///{html_path.replace(os.sep, "/")}',
        js_api=api,
        width=1340,
        height=880,
        min_size=(1050, 720),
        background_color='#06070a'
    )
    
    print('Starting Cayin RU3 Desktop Studio App...')
    webview.start(debug=False)

if __name__ == '__main__':
    main()
