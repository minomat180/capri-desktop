# Her voice (Piper, local)

Off by default. Turn it on: `capri-ctl voice on`, off again with `capri-ctl voice off`.
`capri-ctl voice list` shows the installed voices, `capri-ctl voice <id>` picks one, and
`capri-ctl voice say "..."` makes one line without her saying it.

Nothing here is in git (the venv is 200 MB, each voice ~60 MB). To set it up:

```sh
python3 -m venv linux/tts/venv && linux/tts/venv/bin/pip install piper-tts
cd linux/tts/voices
# one of: en/en_US/amy/medium/en_US-amy-medium, en/en_GB/jenny_dioco/medium/en_GB-jenny_dioco-medium,
#         en/en_US/hfc_female/medium/en_US-hfc_female-medium, en/en_GB/cori/high/en_GB-cori-high
p=en/en_US/amy/medium/en_US-amy-medium; n=$(basename $p)
curl -fL -o $n.onnx      "https://huggingface.co/rhasspy/piper-voices/resolve/main/$p.onnx"
curl -fL -o $n.onnx.json "https://huggingface.co/rhasspy/piper-voices/resolve/main/$p.onnx.json"
```

Measured on this ThinkPad T480 (4c/8t, no GPU), one 1-2 sentence line:

| voice | load | per line |
|---|---|---|
| en_US-amy-medium | 10.8 s | 0.9 s |
| en_GB-jenny_dioco-medium | 11.2 s | 0.6 s |
| en_US-hfc_female-medium | 7.7 s | 0.7 s |
| en_GB-cori-high | 11.7 s | **4.7 s** (too slow) |

So: `medium` voices only, and the model is kept loaded by `piper-server.py` (started on her first
spoken line, not at boot). Piper's code is GPL-3.0; it runs as a separate process, never linked in.
Voice weights are licensed per voice (check the voice's card on `rhasspy/piper-voices`).
