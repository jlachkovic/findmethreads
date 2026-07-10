#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPORT="$PROJECT_DIR/data/index.html"

if [[ ! -f "$REPORT" ]]; then
  cd "$PROJECT_DIR"
  npm run check
fi

open -a "Google Chrome" "$REPORT"
