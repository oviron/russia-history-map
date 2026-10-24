#!/bin/sh
# Локальное превью: Artifact сам оборачивает страницу в doctype/head/body, здесь делаем это вручную.
set -eu
cd "$(dirname "$0")/.."
OUT=.cache/preview
rm -rf "$OUT" && mkdir -p "$OUT"
cp -R site/data site/*.js "$OUT/"
{ printf '<!doctype html>\n<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"></head><body>\n'
  cat site/index.html
  printf '\n</body></html>\n'; } > "$OUT/index.html"
exec python3 -m http.server "${1:-8765}" -d "$OUT" --bind 127.0.0.1
