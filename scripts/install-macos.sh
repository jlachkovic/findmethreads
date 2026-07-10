#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PLIST_ID="com.findmethreads.app"
PLIST_SOURCE="$PROJECT_DIR/launchd/$PLIST_ID.plist"
PLIST_TARGET="$HOME/Library/LaunchAgents/$PLIST_ID.plist"

if ! command -v npm >/dev/null 2>&1; then
  echo "npm was not found. Install Node.js first, then run this again."
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents"
mkdir -p "$PROJECT_DIR/data"

if [[ ! -f "$PROJECT_DIR/config.json" ]]; then
  cp "$PROJECT_DIR/config.example.json" "$PROJECT_DIR/config.json"
  echo "Created local config.json from config.example.json. Edit it before relying on matches."
fi

sed "s#__PROJECT_DIR__#$PROJECT_DIR#g" "$PLIST_SOURCE" > "$PLIST_TARGET"

launchctl unload "$PLIST_TARGET" >/dev/null 2>&1 || true
launchctl load "$PLIST_TARGET"
launchctl start "$PLIST_ID" || true

echo "Installed $PLIST_ID"
echo "Runs daily at 9:15 AM."
echo "Report archive:"
echo "$PROJECT_DIR/data/index.html"
echo
echo "Opening archive..."
open -a "Google Chrome" "$PROJECT_DIR/data/index.html" 2>/dev/null || true
