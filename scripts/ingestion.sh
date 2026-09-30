#!/usr/bin/env bash
# Starts the Python ingestion engine (discovery, downloads, proxy control).
set -euo pipefail
cd "$(dirname "$0")/.."
[ -x .venv/bin/python ] || ./scripts/setup-python.sh
exec .venv/bin/python -m reelflow_ingestion
