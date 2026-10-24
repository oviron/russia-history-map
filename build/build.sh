#!/bin/sh
# Полная сборка данных: исходники → .cache/raw.geojson → site/data/*.json, затем сверка.
# Исходники кладутся в .cache/src (скачиваются, если их нет).
set -eu
cd "$(dirname "$0")/.."
SRC=.cache/src
mkdir -p "$SRC/clio" "$SRC/ne" site/data
if [ ! -f "$SRC/clio/cliopatria.geojson" ]; then
  curl -sfL -o "$SRC/clio/c.zip" https://github.com/Seshat-Global-History-Databank/cliopatria/raw/main/cliopatria.geojson.zip
  unzip -o -q "$SRC/clio/c.zip" -d "$SRC/clio"
  mv "$SRC"/clio/cliopatria*.geojson "$SRC/clio/cliopatria.geojson"
fi
NE=https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson
for f in ne_50m_lakes ne_50m_land ne_10m_admin_1_states_provinces; do
  [ -f "$SRC/ne/$f.geojson" ] || curl -sfL -o "$SRC/ne/$f.geojson" "$NE/$f.geojson"
done

uv run -q --with shapely --with pyproj python -I build/build.py "$SRC/clio/cliopatria.geojson" "$SRC/ne" .cache
MS="npx -y mapshaper@0.6.102"
$MS .cache/raw.geojson -simplify 10% keep-shapes -filter-slivers min-area=20km2 \
  -o format=topojson quantization=60000 site/data/borders.json
$MS -i "$SRC/ne/ne_50m_land.geojson" "$SRC/ne/ne_50m_lakes.geojson" combine-files \
  -clip bbox=-180,10,180,85 -simplify 20% keep-shapes -filter-fields \
  -rename-layers land,lakes -o format=topojson quantization=60000 site/data/base.json
cp .cache/corrections.json site/data/corrections.json
uv run -q --with shapely python -I build/validate.py .cache/raw.geojson
