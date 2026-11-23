# Her voice (Piper, local)

Off by default. Turn it on: `capri-ctl voice on`, off again with `capri-ctl voice off`.
`capri-ctl voice list` shows the installed voices, `capri-ctl voice <id>` picks one, and
`capri-ctl voice say "..."` makes one line without her saying it.

She speaks with **Kokoro af_heart** (Apache-2.0). It sounds far better than Piper but costs about
5 s a line on this laptop's CPU, so **every line is cached by its text** under
`~/.cache/capri/voice/`: her 169 fixed lines are made once with `capri-ctl voice prerender`
(~12 min, ~7 MB) and play instantly forever after. Only a new chat answer waits.

Piper is still supported (`voiceEngine: 'piper'` in the config) if you ever want speed over sound.

Nothing here is in git (the venv is 200 MB, each voice ~60 MB). To set it up:

```sh
python3 -m venv linux/tts/venv
linux/tts/venv/bin/pip install kokoro-onnx soundfile piper-tts
cd linux/tts/voices
# Kokoro (what she uses): the model and its voices
curl -fLO https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx
curl -fLO https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin
# Piper (optional, the fast flat one)
# one of: en/en_US/amy/medium/en_US-amy-medium, en/en_GB/jenny_dioco/medium/en_GB-jenny_dioco-medium,
#         en/en_US/hfc_female/medium/en_US-hfc_female-medium, en/en_GB/cori/high/en_GB-cori-high
p=en/en_US/amy/medium/en_US-amy-medium; n=$(basename $p)
curl -fL -o $n.onnx      "https://huggingface.co/rhasspy/piper-voices/resolve/main/$p.onnx"
curl -fL -o $n.onnx.json "https://huggingface.co/rhasspy/piper-voices/resolve/main/$p.onnx.json"
```

Measured on this ThinkPad T480 (4c/8t, no GPU), one 1-2 sentence line:

| Kokoro | load | per line | cached |
|---|---|---|---|
| af_heart (hers) | 5 s | ~5 s | **0 ms** |

Piper, for comparison:

| voice | load | per line |
|---|---|---|
| en_US-amy-medium | 10.8 s | 0.9 s |
| en_GB-jenny_dioco-medium | 11.2 s | 0.6 s |
| en_US-hfc_female-medium | 7.7 s | 0.7 s |
| en_GB-cori-high | 11.7 s | **4.7 s** (too slow) |

So: `medium` voices only, and the model is kept loaded by `piper-server.py` (started on her first
spoken line, not at boot). Piper's code is GPL-3.0; it runs as a separate process, never linked in.
Voice weights are licensed per voice (check the voice's card on `rhasspy/piper-voices`).
