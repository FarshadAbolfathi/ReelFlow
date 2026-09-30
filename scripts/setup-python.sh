#!/usr/bin/env bash
# Creates .venv with Python 3.12+ and installs the ingestion engine (editable).
set -euo pipefail
cd "$(dirname "$0")/.."
PY_BIN="${PYTHON:-$(command -v python3.12 || command -v python3.13 || command -v python3)}"
"$PY_BIN" -c 'import sys; assert sys.version_info >= (3, 12), "Python 3.12+ required"'
[ -d .venv ] || "$PY_BIN" -m venv .venv
.venv/bin/pip install -q --upgrade pip
.venv/bin/pip install -q -e "packages/network[test]" -e "apps/ingestion[test]"
echo "Python environment ready (.venv). Optional: .venv/bin/pip install -e 'apps/ingestion[ytdlp]'"
