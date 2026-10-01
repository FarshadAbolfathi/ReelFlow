#!/usr/bin/env bash
# Creates .venv with Python 3.12+ and installs the ingestion engine (editable).
set -euo pipefail
cd "$(dirname "$0")/.."
PY_BIN="${PYTHON:-$(command -v python3.12 || command -v python3.13 || command -v python3)}"
"$PY_BIN" -c 'import sys; assert sys.version_info >= (3, 12), "Python 3.12+ required"'
[ -d .venv ] || "$PY_BIN" -m venv --without-pip .venv

# Some macOS setups report an empty version to Python, which crashes pip.
if [ "$(uname)" = "Darwin" ] && [ -z "$(.venv/bin/python -c 'import platform; print(platform.mac_ver()[0])')" ]; then
  SITE="$(.venv/bin/python -c 'import sysconfig; print(sysconfig.get_paths()["purelib"])')"
  cp scripts/macos_version_fix.py "$SITE/reelflow_macos_version_fix.py"
  echo "import reelflow_macos_version_fix" > "$SITE/reelflow_macos_version_fix.pth"
  FIXED="$(.venv/bin/python -c 'import platform; print(platform.mac_ver()[0])')"
  if [ -z "$FIXED" ]; then
    echo "Could not work around the empty macOS version — please report: $(sw_vers 2>&1 | tr '\n' ' ')" >&2
    exit 1
  fi
  echo "Applied macOS version workaround ($FIXED)"
fi

.venv/bin/python -m pip --version >/dev/null 2>&1 || .venv/bin/python -m ensurepip --upgrade --default-pip >/dev/null
.venv/bin/python -m pip install -q --upgrade pip
.venv/bin/python -m pip install -q -e "packages/network[test]" -e "apps/ingestion[test]"
echo "Python environment ready (.venv). Optional: .venv/bin/pip install -e 'apps/ingestion[ytdlp]'"
