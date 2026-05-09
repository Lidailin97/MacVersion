#!/bin/bash
set -e

RUN_DIR="${BOSS_RUN_DIR:-$HOME/.boss-feishu-greeter-260505}"
if ! mkdir -p "$RUN_DIR" 2>/dev/null; then
  RUN_DIR="$(pwd)/.run"
  mkdir -p "$RUN_DIR"
fi

touch "$RUN_DIR/.stop"
echo "{\"stopped\":true,\"stop_file\":\"$RUN_DIR/.stop\"}"

