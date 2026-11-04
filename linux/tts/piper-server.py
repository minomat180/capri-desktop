#!/usr/bin/env python3
"""Her voice, kept warm.

Loading a Piper voice takes ~8-11 s on this laptop; speaking a line takes ~0.6-0.9 s. So the model
is loaded once, here, and this process stays up: the Capri service (linux/daemon/voice.js) writes
one JSON request per line on stdin and reads one JSON reply per line on stdout.

  in :  {"id": "abc", "text": "New gig.", "path": "/tmp/capri-voice/abc.wav"}
  out:  {"id": "abc", "ok": true, "path": "...", "ms": 612, "seconds": 2.8}
        {"id": "abc", "ok": false, "error": "..."}

Nothing is spoken here: it only writes a WAV. The overlay plays it, through her existing volume
and mute (src/renderer/js/voice.js).
"""

import json
import os
import sys
import time
import wave


def log(*a):
    print("[piper]", *a, file=sys.stderr, flush=True)


def main():
    if len(sys.argv) < 2:
        log("usage: piper-server.py <voice.onnx>")
        return 2
    model = sys.argv[1]
    try:
        from piper import PiperVoice
    except ImportError as err:
        log("piper not installed:", err)
        return 3
    t0 = time.time()
    try:
        voice = PiperVoice.load(model)
    except Exception as err:  # noqa: BLE001
        log("could not load", model, err)
        return 4
    log(f"loaded {os.path.basename(model)} in {time.time() - t0:.1f}s")
    print(json.dumps({"ready": True, "voice": os.path.basename(model)}), flush=True)

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
            with wave.open(path, "wb") as out:
                voice.synthesize_wav(text[:600], out)
            with wave.open(path) as f:
                seconds = f.getnframes() / f.getframerate()
            print(json.dumps({"id": rid, "ok": True, "path": path,
                              "ms": round((time.time() - t1) * 1000), "seconds": round(seconds, 2)}), flush=True)
        except Exception as err:  # noqa: BLE001
            print(json.dumps({"id": rid, "ok": False, "error": str(err)[:200]}), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
