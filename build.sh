#!/bin/sh
# Empaqueta los drivers de CHIRP (sin la interfaz wx) en chirp.zip para cargarlos en Pyodide.
# Uso: ./build.sh [ruta-al-codigo-de-chirp]
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="${1:-$HERE/../vendor/chirp-src}"
OUT="$HERE/chirp.zip"
rm -f "$OUT"
cd "$SRC"
zip -qr "$OUT" chirp -x 'chirp/wxui/*' 'chirp/locale/*' 'chirp/share/*' '*/__pycache__/*' '*.pyc'
echo "chirp.zip: $(du -h "$OUT" | cut -f1) ($(git -C "$SRC" rev-parse --short HEAD 2>/dev/null || echo sin-git))"
