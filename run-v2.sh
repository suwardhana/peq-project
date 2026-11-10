#!/bin/sh
# Start the Cayin RU3 v2 web UI server (macOS/Linux port of run-v2.bat).
set -u
cd "$(dirname "$0")"

TITLE="Cayin RU3 v2"
PY=".venv-mac/bin/python"
SERVER="v2/server.py"
URL="http://127.0.0.1:8765"

if [ ! -x "$PY" ]; then
    echo "[ERROR] Python virtual environment tidak ditemukan."
    echo "Expected: $PWD/$PY"
    echo "Buat dengan: python3 -m venv .venv-mac && .venv-mac/bin/pip install hidapi"
    [ "${RU3_NO_PAUSE:-0}" = "1" ] || read -r _
    exit 1
fi

if [ ! -f "$SERVER" ]; then
    echo "[ERROR] Server v2 tidak ditemukan."
    echo "Expected: $PWD/$SERVER"
    [ "${RU3_NO_PAUSE:-0}" = "1" ] || read -r _
    exit 1
fi

echo "========================================================"
echo "  CAYIN RU3 v2 - WEB UI"
echo "========================================================"
echo
echo "Server : $URL"
echo "Stop   : tekan Ctrl+C di jendela ini"
echo

if [ "${RU3_NO_BROWSER:-0}" != "1" ]; then
    ( sleep 2; open "$URL" >/dev/null 2>&1 || true ) &
fi

"$PY" "$SERVER"
EXIT_CODE=$?

if [ "$EXIT_CODE" -ne 0 ]; then
    echo
    echo "Server berhenti dengan kode $EXIT_CODE."
    [ "${RU3_NO_PAUSE:-0}" = "1" ] || read -r _
fi

exit "$EXIT_CODE"
