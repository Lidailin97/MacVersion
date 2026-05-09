#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
osascript -l JavaScript "$SCRIPT_DIR/check_chrome.jxa"

