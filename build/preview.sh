#!/bin/sh
# Локальное превью статической версии.
set -eu
cd "$(dirname "$0")/.."
sh build/static.sh .cache/preview
exec python3 -m http.server "${1:-8765}" -d .cache/preview --bind 127.0.0.1
