#!/usr/bin/env bash
set -euo pipefail
# Update self-hosted vendor files from jsDelivr
# Usage: ./scripts/update-vendor.sh [three_version]
# Example: ./scripts/update-vendor.sh 0.170.0
# If no args, uses latest from jsDelivr API

THREE_VER=${1:-}

if [ -z "$THREE_VER" ]; then
  THREE_VER=$(curl -s https://data.jsdelivr.com/v1/package/npm/three | python3 -c "import sys,json; print(json.load(sys.stdin)['tags']['latest'])")
  echo "Latest three: $THREE_VER"
fi

echo "Updating to three@$THREE_VER"

# three module + addons (skip if dir missing or version unchanged requested)
if [ -n "$THREE_VER" ]; then
  curl -sSL "https://cdn.jsdelivr.net/npm/three@${THREE_VER}/build/three.module.js" -o vendor/three/build/three.module.js
  curl -sSL "https://cdn.jsdelivr.net/npm/three@${THREE_VER}/examples/jsm/utils/BufferGeometryUtils.js" -o vendor/three/examples/jsm/utils/BufferGeometryUtils.js
  echo "three $(wc -c < vendor/three/build/three.module.js) bytes"
fi

# update index.html vendor comment (best-effort)
if grep -q "Vendor: self-hosted" index.html; then
  # replace the whole comment line with new versions
  # keep three comment as-is unless we updated it
  sed -i.bak "s/<!-- Vendor: self-hosted.*/<!-- Vendor: self-hosted (was CDN jsdelivr) — three @${THREE_VER} -->/" index.html || true
  rm -f index.html.bak
fi

# update docs-site/attributions.md versions (best-effort)
if [ -f docs-site/attributions.md ]; then
  sed -i.bak "s/three.*v0\.[0-9.]*.*$/three\` v${THREE_VER}/" docs-site/attributions.md || true
  sed -i.bak "s/\*\*Package\*\*: \`three\` v[0-9.]*/**Package**: \`three\` v${THREE_VER}/" docs-site/attributions.md || true
  sed -i.bak "s/three@[0-9.]*\`)/three@${THREE_VER}\`)/" docs-site/attributions.md || true
  rm -f docs-site/attributions.md.bak
fi

# hashes for CSP/docs (optional)
python3 << PY
import hashlib, base64, pathlib
for p in ["vendor/three/build/three.module.js"]:
    data=pathlib.Path(p).read_bytes()
    h=base64.b64encode(hashlib.sha384(data).digest()).decode()
    print(f"{p}: sha384-{h} ({len(data)} bytes)")
PY

echo "Update index.html comment manually to reflect new versions"
echo "Then bun tests/tests.js && commit with VERSION bump"
