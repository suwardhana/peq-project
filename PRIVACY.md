# Privacy Policy — Cayin RU3 Control (Chrome extension)

_Last updated: 2026-11-10_

**Cayin RU3 Control** does not collect, store, transmit, sell, or share any
personal or user data.

## What the extension does

- Talks to your Cayin RU3 USB DAC directly from your browser using the WebHID
  API, only after you grant access to the device in Chrome's device chooser.
- On `squig.link` pages, reads the parametric EQ filters (frequency, Q, gain)
  currently shown on the page so you can apply them to the DAC.

## Data handling

- All processing happens locally in your browser. The extension makes no
  network requests, has no server, and uses no analytics, telemetry, or
  advertising.
- The extension does not use cookies, `localStorage`, or `chrome.storage`, and
  does not read your browsing history, account information, or any page content
  other than the EQ filter values on `squig.link`.
- EQ values and device settings are sent only to your USB DAC.

## Permissions

- **Host access to `squig.link` and `*.squig.link`**: used solely to read the
  active EQ filters on those pages and show an "Apply" control.
- **WebHID device access**: requested by Chrome at runtime, only for the device
  you select.

## Third parties

No data is shared with third parties. This project is unaffiliated with Cayin
and Squiglink.

## Changes and contact

Any change to this policy will be published in this file in the project
repository: <https://github.com/suwardhana/peq-project>. Questions can be sent
as an issue there.
