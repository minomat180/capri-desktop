#!/bin/sh
# Create the voice-lab venv outside the repo and install mlx-audio into it.
# Usage: macos/voice-lab/setup.sh   (Apple Silicon, Python 3.10-3.13 on PATH as python3)
set -eu
LAB="${CAPRI_VOICE_LAB:-$HOME/.local/share/capri/voice-lab}"
PY="${PYTHON:-python3}"
mkdir -p "$LAB"
[ -x "$LAB/venv/bin/python" ] || "$PY" -m venv "$LAB/venv"
"$LAB/venv/bin/python" -m pip install -q -U pip
"$LAB/venv/bin/python" -m pip install -q "mlx-audio==0.6.7"
"$LAB/venv/bin/python" -c "import mlx_audio, mlx.core as mx; print('mlx-audio ok, metal:', mx.metal.is_available())"
echo "venv: $LAB/venv"
