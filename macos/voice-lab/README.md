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

Options: `--only kokoro,phonon`, `--skip fish`, `--redo` (re-run finished groups), `--page-only`.
Models load one at a time. Re-running with the same `--out` picks up where it stopped. The clips,
venv and models stay out of the repo (`~/.local/share/capri/voice-lab`, `~/.cache/huggingface`).
