#!/bin/sh
# Her voice on macOS: a venv with mlx-audio, the model, and the reference clip she is cloned from.
#
#   macos/voice/setup.sh [--ref <clip.wav> --text "<what is said in it>"] [--name drift]
#
# Without --ref it takes the "drift" clip from the voice lab (macos/voice-lab, run1). Everything
# lands in ~/.local/share/capri/voice (venv, <name>.wav, <name>.txt) and ~/.cache/huggingface
# (the model, about 22 GB for Fish Audio Drama 3 4-bit). Then: capri-ctl voice on.
set -eu
HOME_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/capri/voice"
LAB="$HOME/.local/share/capri/voice-lab"
MODEL="${CAPRI_VOICE_MODEL:-mlx-community/fish-audio-drama-3-4bit}"
NAME=drift
REF="$LAB/run1/refs/drift.wav"
# what the voice lab has every designed voice say (REF_TEXT in macos/voice-lab/audition.py)
TEXT="Hey, choom. I've been floating up here all night, watching the stars and keeping an eye on your agents. Want to hear what they've been up to?"
while [ $# -gt 0 ]; do
  case "$1" in
    --ref) REF=$2; shift 2 ;;
    --text) TEXT=$2; shift 2 ;;
    --name) NAME=$2; shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
if [ -z "${PYTHON:-}" ]; then
  for c in python3.13 python3.12 python3.11 python3.10 \
           /opt/homebrew/opt/python@3.13/bin/python3.13 /opt/homebrew/opt/python@3.12/bin/python3.12; do
    if command -v "$c" >/dev/null 2>&1; then PYTHON="$c"; break; fi
  done
fi
[ -n "${PYTHON:-}" ] || { echo "no Python 3.10-3.13 (mlx has no wheels for newer); brew install python@3.12 or set PYTHON" >&2; exit 1; }
[ -f "$REF" ] || { echo "no reference clip at $REF (run the voice lab, or pass --ref and --text)" >&2; exit 1; }

mkdir -p "$HOME_DIR"
[ -x "$HOME_DIR/venv/bin/python" ] || "$PYTHON" -m venv "$HOME_DIR/venv"
"$HOME_DIR/venv/bin/python" -m pip install -q -U pip
"$HOME_DIR/venv/bin/python" -m pip install -q "mlx-audio==0.6.7"
cp "$REF" "$HOME_DIR/$NAME.wav"
printf '%s\n' "$TEXT" > "$HOME_DIR/$NAME.txt"
echo "fetching $MODEL (once; about 22 GB for Fish)..."
"$HOME_DIR/venv/bin/python" -c "import sys; from huggingface_hub import snapshot_download; print(snapshot_download(sys.argv[1]))" "$MODEL"
echo "voice ready: $HOME_DIR ($NAME). Turn it on: capri-ctl voice on; make her fixed lines: capri-ctl voice prerender"
