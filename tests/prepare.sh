#!/bin/sh
# Copia desde el código de CHIRP lo que necesitan las pruebas (imágenes y tests originales).
# Uso: ./tests/prepare.sh [ruta-al-codigo-de-chirp]
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="${1:-$HERE/../../vendor/chirp-src}"
OUT="$HERE/fixtures"
rm -rf "$OUT"
mkdir -p "$OUT/tests"
cp -R "$SRC/tests/images" "$OUT/tests/images"
cp "$SRC"/tests/*.py "$SRC"/tests/*.yaml "$SRC"/tests/*.txt "$SRC"/tests/*.tsv "$OUT/tests/" 2>/dev/null || true
mkdir -p "$OUT/tests/unit" && cp "$SRC/tests/unit/__init__.py" "$OUT/tests/unit/"
cp "$SRC/chirp/serialtrace.py" "$OUT/" 2>/dev/null || true
( cd "$OUT/tests/images" && ls > ../images.txt )
( cd "$OUT/tests" && ls *.py *.yaml *.txt *.tsv > files.txt )
echo "fixtures listas en $OUT"
