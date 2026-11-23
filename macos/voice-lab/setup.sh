#!/bin/sh
# Create the voice-lab venv outside the repo and install mlx-audio into it.
# Usage: macos/voice-lab/setup.sh   (Apple Silicon; needs Python 3.10-3.13, mlx has no wheels
# for newer ones yet: `brew install python@3.12` if none is installed, or set PYTHON=...)
set -eu
LAB="${CAPRI_VOICE_LAB:-$HOME/.local/share/capri/voice-lab}"
if [ -z "${PYTHON:-}" ]; then
  for c in python3.13 python3.12 python3.11 python3.10 \
           /opt/homebrew/opt/python@3.13/bin/python3.13 /opt/homebrew/opt/python@3.12/bin/python3.12; do
    if command -v "$c" >/dev/null 2>&1; then PYTHON="$c"; break; fi
  done
fi
[ -n "${PYTHON:-}" ] || { echo "no Python 3.10-3.13 found; brew install python@3.12 or set PYTHON" >&2; exit 1; }
mkdir -p "$LAB"
[ -x "$LAB/venv/bin/python" ] || "$PYTHON" -m venv "$LAB/venv"
"$LAB/venv/bin/python" -m pip install -q -U pip
# misaki[en] is Kokoro's phonemizer (pulls spacy and torch, about 1.3 GB); the other models do not need it.
"$LAB/venv/bin/python" -m pip install -q "mlx-audio==0.6.7" "misaki[en]==0.9.4"
"$LAB/venv/bin/python" -c "import mlx_audio, mlx.core as mx; print('mlx-audio ok, metal:', mx.metal.is_available())"
echo "venv: $LAB/venv ($("$LAB/venv/bin/python" --version))"
