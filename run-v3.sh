#!/bin/sh
# Start the Protocol Micro v3 backend and open the control deck.
set -eu
cd "$(dirname "$0")"

PY=".venv-mac/bin/python"
URL="http://127.0.0.1:8766"

if [ ! -x "$PY" ]; then
    echo "[ERROR] Python venv not found: $PY"
    echo "        python3 -m venv .venv-mac && .venv-mac/bin/pip install hidapi"
    exit 1
fi

open_ui() {
    if [ "${MICRO_NO_BROWSER:-0}" != "1" ]; then
        ( sleep 2; open "$URL" >/dev/null 2>&1 || true ) &
    fi
}

# Already up? Just open the UI instead of failing on "address in use".
if curl -s -m 2 -o /dev/null -w '%{http_code}' "$URL/api/state" 2>/dev/null \
        | grep -qx '200'; then
    echo "Protocol Micro v3 is already running at $URL"
    if [ "${MICRO_NO_BROWSER:-0}" != "1" ]; then
        open "$URL" >/dev/null 2>&1 || true
    fi
    echo "Stop it with: lsof -ti tcp:8766 | xargs kill"
    exit 0
fi

echo "========================================================"
echo "  CRINEAR PROTOCOL MICRO v3 — WEB UI"
echo "========================================================"
echo
echo "Server : $URL"
echo "Stop   : Ctrl+C"
echo

open_ui

exec "$PY" v3/server.py --port 8766
