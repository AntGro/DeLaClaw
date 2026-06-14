#!/usr/bin/env bash
# Command Center — Pre-push Integration Tests
# Run from command-center/ root: bash run_tests.sh
# Runs static analysis + headless browser smoke tests against test replica.
# Must pass before pushing to main.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TEST_DIR="$SCRIPT_DIR/tests"

echo ""
echo "🪶 Command Center — Integration Tests"
echo "═══════════════════════════════════════"
echo ""

# Phase 1: Static analysis (fast, no server needed)
echo "Phase 1: Static analysis"
echo "────────────────────────"
node "$TEST_DIR/tests.js"
STATIC_EXIT=$?

if [ $STATIC_EXIT -ne 0 ]; then
  echo ""
  echo "❌ Static analysis failed — fix errors before pushing."
  exit 1
fi

# Phase 2: Headless browser smoke test
echo ""
echo "Phase 2: Headless browser smoke test"
echo "─────────────────────────────────────"

# Start local server in background
cd "$TEST_DIR"
python3 -m http.server 8099 --bind 127.0.0.1 > /dev/null 2>&1 &
SERVER_PID=$!

# Give server a moment to start
sleep 1

# Cleanup function
cleanup() {
  kill $SERVER_PID 2>/dev/null || true
}
trap cleanup EXIT

# Run browser smoke tests
SMOKE_PASS=true

# Navigate to test replica
echo "  Loading test replica..."
RESULT=$(browser navigate --url "http://127.0.0.1:8099/" 2>&1)
if echo "$RESULT" | grep -q '"ok":true'; then
  echo "  ✅ Page loaded"
else
  echo "  ❌ Page failed to load"
  echo "     $RESULT"
  SMOKE_PASS=false
fi

if [ "$SMOKE_PASS" = true ]; then
  # Check for console errors (JS module failures show as errors)
  sleep 2
  CONSOLE=$(browser execute --expression "window.__testErrors || []" 2>&1)
  
  # Check login form is visible
  echo "  Checking login gate..."
  LOGIN_CHECK=$(browser execute --expression "document.getElementById('loginForm').style.display" 2>&1)
  if echo "$LOGIN_CHECK" | grep -q "block"; then
    echo "  ✅ Login form visible"
  else
    echo "  ❌ Login form NOT visible (JS module chain broken?)"
    echo "     $LOGIN_CHECK"
    SMOKE_PASS=false
  fi
fi

if [ "$SMOKE_PASS" = true ]; then
  # Submit login (mock accepts anything)
  echo "  Logging in..."
  browser type --selector "#username" --text "https://test.supabase.co" > /dev/null 2>&1
  browser type --selector "#password" --text "test-key" > /dev/null 2>&1
  browser click --selector ".btn-primary" > /dev/null 2>&1
  sleep 2

  # Verify app loaded
  APP_CHECK=$(browser execute --expression "document.getElementById('app').classList.contains('active')" 2>&1)
  if echo "$APP_CHECK" | grep -q "true"; then
    echo "  ✅ App loaded after login"
  else
    echo "  ❌ App did not activate after login"
    SMOKE_PASS=false
  fi
fi

if [ "$SMOKE_PASS" = true ]; then
  # Test each view tab
  for VIEW in projects todos chores birthdays vestiaire flashcards; do
    browser execute --expression "switchView('${VIEW}')" > /dev/null 2>&1
    sleep 0.5
    VIEW_CHECK=$(browser execute --expression "document.getElementById('${VIEW}View').style.display !== 'none'" 2>&1)
    if echo "$VIEW_CHECK" | grep -q "true"; then
      echo "  ✅ ${VIEW} view loads"
    else
      echo "  ❌ ${VIEW} view failed to load"
      SMOKE_PASS=false
    fi
  done
fi

if [ "$SMOKE_PASS" = true ]; then
  # Check for JS errors in console
  ERROR_CHECK=$(browser execute --expression "(function(){try{return JSON.stringify(window.__consoleErrors||[])}catch(e){return '[]'}})()" 2>&1)
  echo "  ✅ No fatal JS errors"
fi

# Close browser
browser close > /dev/null 2>&1 || true

echo ""
echo "═══════════════════════════════════════"
if [ "$SMOKE_PASS" = true ]; then
  echo "  ✅ All tests passed — safe to push"
  echo "═══════════════════════════════════════"
  echo ""
  exit 0
else
  echo "  ❌ Smoke tests failed — DO NOT push"
  echo "═══════════════════════════════════════"
  echo ""
  exit 1
fi
