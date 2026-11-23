# Voice lab (macOS)

Audition local text-to-speech voices for Capri before wiring one into her. Everything runs on
the Mac through [mlx-audio](https://github.com/Blaizzy/mlx-audio) (MIT); nothing leaves the machine
except the model downloads from Hugging Face.

```sh
macos/voice-lab/setup.sh
~/.local/share/capri/voice-lab/venv/bin/python macos/voice-lab/audition.py \
    --out ~/.local/share/capri/voice-lab/run1 --open
```

`audition.py` renders every line in `lines.txt` with each group below, times each clip with the
model warm, and writes `index.html` next to the clips: play one voice's lines in a row, or pick
a line to hear every voice say it; star voices, add notes, "Copy picks" puts both on the clipboard.

| Group | Model | Voices |
|---|---|---|
| `kokoro` | Kokoro 82M (current Linux voice) | af_heart, af_bella, af_nova |
| `phonon` | Gradium Phonon 31M | 12 English female presets |
| `qwen-design` | Qwen3-TTS 1.7B VoiceDesign | 4 voices described in text (`DESIGNS` in `audition.py`); also writes one reference clip per voice |
| `qwen-clone-17`, `qwen-clone-06` | Qwen3-TTS 1.7B / 0.6B Base | the 4 designed voices, cloned from those reference clips |
| `ming` | Ming-3.0 TTS 0.5B | 3 built-in voices and one description; also tag lines like `[Laughter]` |
| `fish` | Fish Audio Drama 3, 4-bit | the 4 designed voices, cloned; also tag lines (about 22 GB download, 26 GB peak memory) |

First run on an M5 Pro (48 GB), 2026-11-23, model warm, median per line: Kokoro 0.07 s, Phonon 0.33 s,
Qwen design 1.05 s, Qwen clone 1.7B 1.33 s / 0.6B 1.12 s, Ming 0.79 s, Fish 1.37 s (peak 28.4 GB).
All models together take about 35 GB in `~/.cache/huggingface` (Fish alone 22 GB).

Options: `--only kokoro,phonon`, `--skip fish`, `--redo` (re-run finished groups), `--page-only`.
Models load one at a time. Re-running with the same `--out` picks up where it stopped. The clips,
venv and models stay out of the repo (`~/.local/share/capri/voice-lab`, `~/.cache/huggingface`).
