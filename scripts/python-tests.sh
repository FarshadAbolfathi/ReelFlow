#!/usr/bin/env bash
# Runs the Python test suites (network isolation + ingestion engine).
set -euo pipefail
cd "$(dirname "$0")/.."
PY=.venv/bin/python
[ -x "$PY" ] || { echo "Python venv missing — run ./scripts/setup-python.sh"; exit 1; }
(cd packages/network && ../../.venv/bin/pytest -q "$@")
(cd apps/ingestion && ../../.venv/bin/pytest -q "$@")
