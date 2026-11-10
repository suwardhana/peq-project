# PEQ Project

Experimental tools for controlling USB DACs' parametric EQ from a computer or
browser, built by reverse-engineering their HID protocols.

| Dir | What | Device |
| --- | --- | --- |
| `v2/` | Python backend + web UI, real protocol captured from the official app | Cayin RU3 |
| `v3/` | Python backend + web UI, 8-band PEQ | CrinEar Protocol Micro |
| `v4/` | Chrome/Edge extension + UI using WebHID (no backend) | Cayin RU3 |
| `micro-dac-extension/`, `squiglink-dac-extension/` | Browser extensions that push a Squiglink / Hangout PEQ to the DAC | Protocol Micro / RU3 |
| `peq.html`, `ui/`, `app.py`, `cayin_backend.py` | Early v1 prototype (its framing guess was later disproved, see `v2/PROTOCOL.md`) | Cayin RU3 |

Each folder has its own README / `PROTOCOL.md` with run instructions, e.g.
`./run-v3.sh` or `python3 v2/server.py`. Python parts need `hidapi`.

## Credits

- The Cayin RU3 protocol was derived by analysing the official Cayin control
  app and web tool at <https://control.cayin.cn/>
  (Copyright © 2021 Zhuhai Spark Electronic Equipment Co., Ltd.).
  All rights to that software and the Cayin name belong to its owners; no
  code from it is distributed here.
- The Protocol Micro protocol follows the Walkplay-family HID handler used by
  the Hangout Audio device PEQ plugin (Pragmatic Audio).

## Disclaimer

Unofficial and unaffiliated with Cayin, CrinEar or Walkplay. This writes
settings to real hardware over USB; use at your own risk. Protocol details were
verified on the author's own units only.

## License

No license has been chosen yet; all rights reserved by default. Add a
`LICENSE` file (e.g. MIT) before inviting reuse.
