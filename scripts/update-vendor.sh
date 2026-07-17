#!/usr/bin/env bash
set -euo pipefail
# Update self-hosted vendor files from jsDelivr
# Usage: ./scripts/update-vendor.sh [supabase_version] [three_version]
# Example: ./scripts/update-vendor.sh 2.110.6 0.170.0
# If no args, uses latest from jsDelivr API

SUPA_VER=${1:-}
THREE_VER=${2:-}

if [ -z "$SUPA_VER" ]; then
  SUPA_VER=$(curl -s https://data.jsdelivr.com/v1/package/npm/@supabase/supabase-js | python3 -c "import sys,json; print(json.load(sys.stdin)['tags']['latest'])")
  echo "Latest supabase-js: $SUPA_VER"
fi
if [ -z "$THREE_VER" ]; then
  THREE_VER=$(curl -s https://data.jsdelivr.com/v1/package/npm/three | python3 -c "import sys,json; print(json.load(sys.stdin)['tags']['latest'])")
  echo "Latest three: $THREE_VER"
fi

echo "Updating to supabase-js@$SUPA_VER + three@$THREE_VER"

# supabase UMD global build (still works, sets window.supabase)
curl -sSL "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@${SUPA_VER}/dist/umd/supabase.js" -o vendor/supabase.js
echo "supabase $(wc -c < vendor/supabase.js) bytes"

# three module + addons (skip if dir missing or version unchanged requested)
if [ -n "$THREE_VER" ]; then
  curl -sSL "https://cdn.jsdelivr.net/npm/three@${THREE_VER}/build/three.module.js" -o vendor/three/build/three.module.js
  curl -sSL "https://cdn.jsdelivr.net/npm/three@${THREE_VER}/examples/jsm/utils/BufferGeometryUtils.js" -o vendor/three/examples/jsm/utils/BufferGeometryUtils.js
  echo "three $(wc -c < vendor/three/build/three.module.js) bytes"
fi

# update index.html vendor comment (best-effort)
if grep -q "Vendor: self-hosted" index.html; then
  # replace the whole comment line with new versions
  SUPA_SIZE_KB=$(du -k vendor/supabase.js | cut -f1)
  # keep three comment as-is unless we updated it
  sed -i.bak "s/<!-- Vendor: self-hosted.*/<!-- Vendor: self-hosted (was CDN jsdelivr) — supabase @${SUPA_VER} (${SUPA_SIZE_KB}KB raw) + three @${THREE_VER} -->/" index.html || true
  rm -f index.html.bak
fi

# update docs-site/attributions.md versions (best-effort)
if [ -f docs-site/attributions.md ]; then
  sed -i.bak "s/@supabase\/supabase-js.*v[0-9.]*.*/@supabase\/supabase-js\` v${SUPA_VER}/" docs-site/attributions.md || true
  sed -i.bak "s/\*\*Package\*\*: \`@supabase\/supabase-js\` v[0-9.]*/**Package**: \`@supabase\/supabase-js\` v${SUPA_VER}/" docs-site/attributions.md || true
  sed -i.bak "s/supabase-js@[0-9.]*\/dist/supabase-js@${SUPA_VER}\/dist/" docs-site/attributions.md || true
  sed -i.bak "s/three.*v0\.[0-9.]*.*$/three\` v${THREE_VER}/" docs-site/attributions.md || true
  sed -i.bak "s/\*\*Package\*\*: \`three\` v[0-9.]*/**Package**: \`three\` v${THREE_VER}/" docs-site/attributions.md || true
  sed -i.bak "s/three@[0-9.]*\`)/three@${THREE_VER}\`)/" docs-site/attributions.md || true
  rm -f docs-site/attributions.md.bak
fi

# hashes for CSP/docs (optional)
python3 << PY
import hashlib, base64, pathlib
for p in ["vendor/supabase.js","vendor/three/build/three.module.js"]:
    data=pathlib.Path(p).read_bytes()
    h=base64.b64encode(hashlib.sha384(data).digest()).decode()
    print(f"{p}: sha384-{h} ({len(data)} bytes)")
PY

echo "Update index.html comment manually to reflect new versions"
echo "Then bun tests/tests.js && commit with VERSION bump"
