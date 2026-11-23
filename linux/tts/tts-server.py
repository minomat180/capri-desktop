#!/usr/bin/env python3
"""Her voice, kept warm.

Three engines, same protocol:
  kokoro  Kokoro-82M through kokoro-onnx (Apache-2.0). Sounds far better; ~5 s a line on this
          laptop's CPU, so lines are cached (see linux/daemon/voice.js) and her fixed ones are
          pre-rendered by `capri-ctl voice prerender`.
  piper   Piper (GPL-3.0, separate process, never linked in). ~0.7 s a line, flatter.
  mlx     Any mlx-audio model on Apple Silicon (macOS), cloned from a reference clip. Hers is
          Fish Audio Drama 3 (4-bit) with the "drift" clip: ~1.4 s a line on an M5 Pro, about
          22-28 GB of memory while loaded (see macos/voice/).

Loading the model costs 4-11 s, so this process stays up: the Capri service writes one JSON
request per line on stdin and reads one JSON reply per line on stdout.

  in :  {"id": "abc", "text": "New gig.", "path": "/.../abc.wav"}
  out:  {"id": "abc", "ok": true, "ms": 4850, "seconds": 2.9} | {"id": "abc", "ok": false, "error": "..."}

Nothing is played here: it only writes a WAV. The overlay plays it, through her existing volume
and mute (src/renderer/js/voice.js).
"""

import argparse
import json
import os
import sys
import time
import wave


def log(*a):
    print("[tts]", *a, file=sys.stderr, flush=True)


class Kokoro:
    """Kokoro-82M. `voice` is one of its names, e.g. af_heart."""

    def __init__(self, model_dir, voice, speed):
        from kokoro_onnx import Kokoro as K  # noqa: PLC0415
        import soundfile  # noqa: PLC0415

        self.sf = soundfile
        self.voice = voice
        self.speed = speed
        self.k = K(os.path.join(model_dir, "kokoro-v1.0.onnx"), os.path.join(model_dir, "voices-v1.0.bin"))
        if voice not in self.k.get_voices():
            raise ValueError(f"no such Kokoro voice: {voice}")

    def say(self, text, path):
        audio, rate = self.k.create(text, voice=self.voice, speed=self.speed, lang="en-us")
        self.sf.write(path, audio, rate)
        return len(audio) / rate


class Piper:
    def __init__(self, model, speed):
        from piper import PiperVoice  # noqa: PLC0415

        self.voice = PiperVoice.load(model)

    def say(self, text, path):
        with wave.open(path, "wb") as out:
            self.voice.synthesize_wav(text, out)
        with wave.open(path) as f:
            return f.getnframes() / f.getframerate()


class Mlx:
    """An mlx-audio model. `ref` is a WAV of the voice to clone, `ref_text` what is said in it;
    without them the model's own default voice is used. Same seed every line: same words, same
    delivery."""

    def __init__(self, model, ref, ref_text, seed):
        import mlx.core as mx  # noqa: PLC0415
        import numpy as np  # noqa: PLC0415
        from mlx_audio.tts.utils import load_model  # noqa: PLC0415

        self.mx, self.np, self.seed = mx, np, seed
        self.model = load_model(model)
        self.kw = {}
        if ref:
            from mlx_audio.tts.generate import load_audio  # noqa: PLC0415

            self.kw = {"ref_audio": load_audio(ref, sample_rate=self.model.sample_rate), "ref_text": ref_text}
        self.render("Okay.")  # the first call compiles; pay for it now, not on her first line

    def render(self, text):
        self.mx.random.seed(self.seed)
        chunks, rate = [], None
        for r in self.model.generate(text=text, **self.kw):
            chunks.append(self.np.asarray(r.audio, dtype=self.np.float32).reshape(-1))
            rate = r.sample_rate
        if not chunks:
            raise RuntimeError("the model made no audio")
        return self.np.concatenate(chunks), rate

    def say(self, text, path):
        audio, rate = self.render(text)
        pcm = (self.np.clip(audio, -1.0, 1.0) * 32767).astype("<i2")
        with wave.open(path, "wb") as out:
            out.setnchannels(1)
            out.setsampwidth(2)
            out.setframerate(int(rate))
            out.writeframes(pcm.tobytes())
        return len(audio) / rate


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--engine", default="kokoro", choices=("kokoro", "piper", "mlx"))
    ap.add_argument("--voice", default="af_heart",
                    help="Kokoro voice name, a Piper .onnx path, or an mlx-audio model id")
    ap.add_argument("--ref", help="mlx: WAV of the voice to clone")
    ap.add_argument("--ref-text", help="mlx: file with what is said in --ref")
    ap.add_argument("--seed", type=int, default=1234, help="mlx: sampling seed")
    ap.add_argument("--speed", type=float, default=1.05)
    ap.add_argument("--models", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "voices"))
    args = ap.parse_args()

    t0 = time.time()
    try:
        if args.engine == "kokoro":
            engine = Kokoro(args.models, args.voice, args.speed)
        elif args.engine == "piper":
            engine = Piper(args.voice, args.speed)
        else:
            ref_text = open(args.ref_text, encoding="utf-8").read().strip() if args.ref_text else None
            engine = Mlx(args.voice, args.ref, ref_text, args.seed)
    except Exception as err:  # noqa: BLE001
        log(f"could not load {args.engine} {args.voice}: {err}")
        print(json.dumps({"ready": False, "error": str(err)[:200]}), flush=True)
        return 4
    log(f"loaded {args.engine}/{args.voice} in {time.time() - t0:.1f}s")
    print(json.dumps({"ready": True, "engine": args.engine, "voice": args.voice}), flush=True)

    for raw in sys.stdin:
        raw = raw.strip()
        if not raw:
            continue
        try:
            req = json.loads(raw)
        except ValueError:
            continue
        rid, text, path = req.get("id"), str(req.get("text") or "").strip(), req.get("path")
        if not text or not path:
            print(json.dumps({"id": rid, "ok": False, "error": "need text and path"}), flush=True)
            continue
        t1 = time.time()
        try:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            seconds = engine.say(text[:600], path)
            print(json.dumps({"id": rid, "ok": True, "ms": round((time.time() - t1) * 1000),
                              "seconds": round(seconds, 2)}), flush=True)
        except Exception as err:  # noqa: BLE001
            print(json.dumps({"id": rid, "ok": False, "error": str(err)[:200]}), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
