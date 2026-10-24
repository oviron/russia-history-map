#!/bin/sh
# Статическая версия сайта в каталог $1: Artifact сам оборачивает страницу в doctype/head/body,
# для обычного хостинга (GitHub Pages, превью) это делаем здесь.
set -eu
cd "$(dirname "$0")/.."
OUT=${1:?каталог}
rm -rf "$OUT" && mkdir -p "$OUT"
cp -R site/data site/*.js "$OUT/"
{ printf '<!doctype html>\n<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"></head><body>\n'
  cat site/index.html
  printf '\n</body></html>\n'; } > "$OUT/index.html"
