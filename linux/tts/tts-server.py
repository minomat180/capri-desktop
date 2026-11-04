#!/usr/bin/env python3
"""Her voice, kept warm.

Two engines, same protocol:
  kokoro  Kokoro-82M through kokoro-onnx (Apache-2.0). Sounds far better; ~5 s a line on this
          laptop's CPU, so lines are cached (see linux/daemon/voice.js) and her fixed ones are
          pre-rendered by `capri-ctl voice prerender`.
  piper   Piper (GPL-3.0, separate process, never linked in). ~0.7 s a line, flatter.

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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--engine", default="kokoro", choices=("kokoro", "piper"))
    ap.add_argument("--voice", default="af_heart", help="Kokoro voice name, or a Piper .onnx path")
    ap.add_argument("--speed", type=float, default=1.05)
    ap.add_argument("--models", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "voices"))
    args = ap.parse_args()

    t0 = time.time()
    try:
        engine = Kokoro(args.models, args.voice, args.speed) if args.engine == "kokoro" else Piper(args.voice, args.speed)
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
