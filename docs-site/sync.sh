#!/bin/bash
# Sync docs-site content from source Markdown files.
# Run from repo root: bash docs-site/sync.sh

set -e
DIR="$(cd "$(dirname "$0")" && pwd)"

cp README.md "$DIR/README.md"
cp docs/SETUP.md "$DIR/setup.md"
cp docs/ARCHITECTURE.md "$DIR/architecture.md"
cp docs/BROWSER_SUPPORT.md "$DIR/browser-support.md"
cp docs/PERFORMANCE.md "$DIR/performance.md"
cp docs/ACCESSIBILITY.md "$DIR/accessibility.md"
cp CONTRIBUTING.md "$DIR/contributing.md"
cp PRIVACY.md "$DIR/privacy.md"
cp ATTRIBUTIONS.md "$DIR/attributions.md"

echo "docs-site synced"
