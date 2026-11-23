#!/usr/bin/env python3
"""Voice audition for Capri: render the same lines with several local TTS
models through mlx-audio on Apple Silicon, time every clip, and build a
listening page (index.html) next to the clips.

    python audition.py --out ~/.local/share/capri/voice-lab/run1 --open

Models are loaded one at a time and released before the next, so peak memory
is the largest single model (Fish Drama 3 4-bit, about 26 GB). Re-running
with the same --out skips groups that already finished.
"""
import argparse
import gc
import json
import shutil
import subprocess
import sys
import time
import traceback
import wave
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent

# Spoken by each designed voice once; the clip is then reused as the clone
# reference, so every line keeps the same voice (Qwen3-TTS "design then clone").
REF_TEXT = (
    "Hey, choom. I've been floating up here all night, watching the stars "
    "and keeping an eye on your agents. Want to hear what they've been up to?"
)

DESIGNS = {
    "spark": "A bright, playful young woman in her early twenties. Light, fairly high voice, "
             "quick and teasing, a little mischievous, American accent.",
    "drift": "A soft, airy young female voice, gentle and dreamy. Speaks a little slowly, "
             "warm and curious, with a smile in her voice. American accent.",
    "glitch": "An energetic young woman with a crisp, clear voice. Confident and cheeky, "
              "a fast-talking hacker girl, slight vocal fry. American accent.",
    "bubbly": "A sweet, youthful female voice, cheerful and bubbly, high pitch, very "
              "expressive and animated, like an anime character dubbed in English.",
}

PHONON_VOICES = {  # name -> embedding id in gradium/phonon-voices (31m, English, female)
    "zoey": "NbpkqMVS3CJeq2j8", "juniper": "NIWIOv5vTi5eRMj8", "everly": "vjFyp2BcCyTlUmYb",
    "harper": "4SZHfMpw-p46Ywgs", "hadley": "bXwrkHhURL1VFJdG", "delia": "nGzMHMPAWGaJFHOo",
    "maeve (UK)": "6PWnV0Nq4wu7RVBT", "pippa (UK)": "uem82D50GRv2Dwma",
    "freya (UK)": "GgfEkEJtxZR7gnpy", "lottie (UK)": "m9MxpY6IUGXtWp76",
    "bryony (UK)": "gfP44RlHwr2kEwk7", "imogen (UK)": "gDT1nz7Ie36ZhL-C",
}


def groups(out: Path):
    refs = out / "refs"
    clone = [
        {"id": d, "label": d, "desc": desc,
         "kw": {"ref_audio": refs / f"{d}.wav", "ref_text": REF_TEXT}}
        for d, desc in DESIGNS.items()
    ]
    return [
        {"id": "kokoro", "title": "Kokoro 82M (current voice)", "model": "mlx-community/Kokoro-82M-bf16",
         "note": "Baseline: what Capri uses on Linux today. Presets only, no emotion control.",
         "voices": [{"id": v, "label": v, "kw": {"voice": v, "lang_code": "a"}}
                    for v in ("af_heart", "af_bella", "af_nova")]},
        {"id": "phonon", "title": "Phonon 31M (Gradium)", "model": "gradium/phonon-31m-en",
         "note": "Tiny and streaming. Designed preset voices, no emotion control.",
         "voices": [{"id": n.split()[0], "label": n,
                     "kw": {"voice": f"hf://gradium/phonon-voices/voices/{i}.safetensors"}}
                    for n, i in PHONON_VOICES.items()]},
        {"id": "qwen-design", "title": "Qwen3-TTS 1.7B VoiceDesign",
         "model": "mlx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign-bf16", "make_refs": True,
         "note": "Voice from a text description, sampled fresh for every line, so it drifts "
                 "a little from line to line. The reference clip is what the clone groups reuse.",
         "voices": [{"id": d, "label": d, "desc": desc, "kw": {"instruct": desc}}
                    for d, desc in DESIGNS.items()]},
        {"id": "qwen-clone-17", "title": "Qwen3-TTS 1.7B Base, cloned from the designed clip",
         "model": "mlx-community/Qwen3-TTS-12Hz-1.7B-Base-bf16",
         "note": "Same designed voice on every line (design then clone).", "voices": clone},
        {"id": "qwen-clone-06", "title": "Qwen3-TTS 0.6B Base, cloned from the designed clip",
         "model": "mlx-community/Qwen3-TTS-12Hz-0.6B-Base-bf16",
         "note": "Smaller and faster version of the clone group.", "voices": clone},
        {"id": "ming", "title": "Ming-3.0 TTS 0.5B", "model": "mlx-community/Ming-3.0-tts-0.5B-bf16",
         "note": "Built-in voices plus one free-form description. Supports tags like [Laughter]. "
                 "Known: numbers should be written as words (the battery line tests that).",
         "extra": ["[Laughter] Done! That's preem.", "[Sigh] No gig. Kinda bored."],
         "voices": [{"id": v, "label": v, "kw": {"voice": v}}
                    for v in ("US_Emma", "US_Stella", "UK_Charlotte")]
                   + [{"id": "described", "label": "described (spark)", "desc": DESIGNS["spark"],
                       "kw": {"instruct": DESIGNS["spark"]}}]},
        {"id": "fish", "title": "Fish Audio Drama 3 (4-bit, 35B MoE)",
         "model": "mlx-community/fish-audio-drama-3-4bit", "min_free_gb": 40,
         "note": "Top of the open-weights leaderboard, cloned from the designed clips. "
                 "About 22 GB download, about 26 GB peak memory. Supports tags like [laughs].",
         "extra": ["[laughs] Done! That's preem.", "[sighs] No gig. Kinda bored."],
         "voices": clone},
    ]


# ---------------------------------------------------------------- helpers

def read_lines(path: Path):
    return [l.strip() for l in path.read_text().splitlines() if l.strip() and not l.startswith("#")]


def write_wav(path: Path, audio: np.ndarray, sr: int):
    pcm = (np.clip(audio, -1.0, 1.0) * 32767).astype("<i2")
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(int(sr))
        w.writeframes(pcm.tobytes())


def mx_call(*names):
    import mlx.core as mx
    for n in names:
        obj = mx
        try:
            for part in n.split("."):
                obj = getattr(obj, part)
            return obj
        except AttributeError:
            continue
    return None


def synth(model, text, kw, seed):
    import mlx.core as mx
    mx.random.seed(seed)
    chunks, sr = [], None
    for r in model.generate(text=text, **kw):
        chunks.append(np.asarray(r.audio, dtype=np.float32).reshape(-1))
        sr = r.sample_rate
    if not chunks:
        raise RuntimeError("model returned no audio")
    return np.concatenate(chunks), sr


def resolve_kw(model, kw, cache):
    """Load reference clips once per voice, the way mlx_audio.server does."""
    kw = dict(kw)
    ref = kw.get("ref_audio")
    if isinstance(ref, Path):
        if not ref.exists():
            raise FileNotFoundError(f"reference clip missing: {ref} (run the qwen-design group first)")
        if ref not in cache:
            try:
                from mlx_audio.tts.generate import load_audio
                cache[ref] = load_audio(str(ref), sample_rate=model.sample_rate)
            except Exception:
                cache[ref] = str(ref)
        kw["ref_audio"] = cache[ref]
    return kw


def save(out: Path, state):
    (out / "results.json").write_text(json.dumps(state, indent=1))
    build_page(out, state)


# ---------------------------------------------------------------- run

def run_group(g, lines, out, state):
    import mlx.core as mx
    from mlx_audio.tts.utils import load_model

    rec = {"id": g["id"], "title": g["title"], "model": g["model"], "note": g["note"],
           "status": "running", "voices": []}
    state["groups"] = [x for x in state["groups"] if x["id"] != g["id"]] + [rec]

    free_gb = shutil.disk_usage(Path.home()).free / 1e9
    if free_gb < g.get("min_free_gb", 0):
        rec.update(status="skipped", error=f"only {free_gb:.0f} GB free disk, needs {g['min_free_gb']}")
        return save(out, state)

    reset = mx_call("reset_peak_memory", "metal.reset_peak_memory")
    peak = mx_call("get_peak_memory", "metal.get_peak_memory")
    clear = mx_call("clear_cache", "metal.clear_cache")
    if reset:
        reset()

    t0 = time.perf_counter()
    try:
        model = load_model(g["model"])
    except Exception as e:
        rec.update(status="failed", error=f"load: {e}", trace=traceback.format_exc())
        return save(out, state)
    rec["load_s"] = round(time.perf_counter() - t0, 1)
    save(out, state)

    all_lines = lines + g.get("extra", [])
    gdir = out / g["id"]
    gdir.mkdir(exist_ok=True)
    refcache = {}
    for v in g["voices"]:
        vrec = {"id": v["id"], "label": v["label"], "desc": v.get("desc"), "clips": []}
        rec["voices"].append(vrec)
        try:
            kw = resolve_kw(model, v["kw"], refcache)
            if g.get("make_refs"):
                (out / "refs").mkdir(exist_ok=True)
                audio, sr = synth(model, REF_TEXT, kw, seed=7)
                write_wav(out / "refs" / f"{v['id']}.wav", audio, sr)
                vrec["ref"] = f"refs/{v['id']}.wav"
            else:
                synth(model, "Okay.", kw, seed=1)  # warm-up: first call compiles, not timed
        except Exception as e:
            vrec["error"] = str(e)
            print(f"  {g['id']}/{v['id']}: {e}", file=sys.stderr)
            save(out, state)
            continue
        for i, text in enumerate(all_lines):
            clip = {"line": i, "text": text}
            try:
                t = time.perf_counter()
                audio, sr = synth(model, text, kw, seed=1000 + i)
                gen = time.perf_counter() - t
                name = f"{v['id']}-{i:02d}.wav"
                write_wav(gdir / name, audio, sr)
                dur = len(audio) / sr
                clip.update(file=f"{g['id']}/{name}", gen_s=round(gen, 2), audio_s=round(dur, 2),
                            rtf=round(dur / gen, 1) if gen else None)
                print(f"  {g['id']}/{v['id']} #{i}: {gen:.2f}s for {dur:.1f}s audio")
            except Exception as e:
                clip["error"] = str(e)
                print(f"  {g['id']}/{v['id']} #{i}: {e}", file=sys.stderr)
            vrec["clips"].append(clip)
        save(out, state)

    if peak:
        rec["peak_gb"] = round(peak() / 1e9, 1)
    rec["status"] = "done"
    del model
    gc.collect()
    if clear:
        clear()
    save(out, state)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", required=True, type=Path, help="output folder (clips, results.json, index.html)")
    ap.add_argument("--lines", type=Path, default=HERE / "lines.txt")
    ap.add_argument("--only", help="comma-separated group ids to run")
    ap.add_argument("--skip", help="comma-separated group ids to skip")
    ap.add_argument("--redo", action="store_true", help="re-run groups that already finished")
    ap.add_argument("--open", action="store_true", help="open index.html when done (macOS)")
    ap.add_argument("--page-only", action="store_true", help="only rebuild index.html")
    a = ap.parse_args()

    out = a.out.expanduser().resolve()
    out.mkdir(parents=True, exist_ok=True)
    lines = read_lines(a.lines)
    rj = out / "results.json"
    state = json.loads(rj.read_text()) if rj.exists() else {"groups": []}
    state.update(lines=lines, ref_text=REF_TEXT, started=state.get("started") or time.strftime("%Y-%m-%d %H:%M"))
    if a.page_only:
        return build_page(out, state)

    only = set(a.only.split(",")) if a.only else None
    skip = set(a.skip.split(",")) if a.skip else set()
    done = {g["id"] for g in state["groups"] if g.get("status") == "done"}
    for g in groups(out):
        if (only and g["id"] not in only) or g["id"] in skip or (g["id"] in done and not a.redo):
            continue
        print(f"== {g['id']}: {g['model']}")
        run_group(g, lines, out, state)
    state["finished"] = time.strftime("%Y-%m-%d %H:%M")
    save(out, state)
    print(f"page: {out / 'index.html'}")
    if a.open and sys.platform == "darwin":
        subprocess.run(["open", str(out / "index.html")])


# ---------------------------------------------------------------- page

PAGE = r"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Capri voice audition</title>
<style>
:root{--bg:#f6f5f3;--fg:#1d1b1a;--mute:#6b6662;--card:#fff;--line:#e2dfdb;--acc:#b5407f;--err:#b3261e}
@media (prefers-color-scheme:dark){:root{--bg:#141313;--fg:#ece9e6;--mute:#9b9590;--card:#1e1c1c;--line:#33302e;--acc:#e07bb5;--err:#f2867e}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.45 -apple-system,system-ui,sans-serif}
main{max-width:1100px;margin:0 auto;padding:20px 16px 80px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:28px 0 2px}
.sub,.note,.meta{color:var(--mute);font-size:13px}
.bar{position:sticky;top:0;background:var(--bg);padding:10px 0;border-bottom:1px solid var(--line);display:flex;gap:10px;flex-wrap:wrap;align-items:center;z-index:2}
select,button,input{font:inherit;color:inherit;background:var(--card);border:1px solid var(--line);border-radius:6px;padding:5px 9px}
button{cursor:pointer}button.on{border-color:var(--acc);color:var(--acc)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:10px;margin-top:8px}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 12px}
.card.fav{border-color:var(--acc)}
.head{display:flex;justify-content:space-between;align-items:center;gap:8px}
.head b{font-size:15px}
.desc{font-size:12px;color:var(--mute);margin:4px 0}
.clip{display:grid;grid-template-columns:1fr;gap:2px;padding:6px 0;border-top:1px solid var(--line)}
.clip .t{font-size:13px}.clip .m{font-size:11px;color:var(--mute);font-variant-numeric:tabular-nums}
audio{width:100%;height:32px}
.err{color:var(--err);font-size:12px}
textarea{width:100%;min-height:34px;font:inherit;font-size:13px;color:inherit;background:transparent;border:1px solid var(--line);border-radius:6px;padding:4px 6px;margin-top:6px}
</style></head><body><main>
<h1>Capri voice audition</h1>
<div class="sub" id="sub"></div>
<div class="bar">
 <label>Show <select id="view"><option value="voice">all lines per voice</option></select></label>
 <button id="favonly">Starred only</button>
 <button id="copy">Copy picks</button><span class="sub" id="copied"></span>
</div>
<div id="root"></div>
</main>
<script>
const DATA = __DATA__;
const KEY = 'capri-audition:' + DATA.started;
let picks = {};
try { picks = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) {}
const keep = () => { try { localStorage.setItem(KEY, JSON.stringify(picks)); } catch (e) {} };
const $ = (t, a = {}, ...kids) => { const e = document.createElement(t); for (const [k, v] of Object.entries(a)) k === 'class' ? e.className = v : k.startsWith('on') ? e[k] = v : e.setAttribute(k, v); e.append(...kids.filter(k => k != null)); return e; };
const view = document.getElementById('view');
DATA.lines.forEach((l, i) => view.append($('option', {value: i}, `line ${i + 1}: ${l}`)));
let favOnly = false;
document.getElementById('sub').textContent = `${DATA.lines.length} lines, started ${DATA.started}${DATA.finished ? ', finished ' + DATA.finished : ' (still running: reload to see more)'}. Times are generation time on this Mac with the model warm; "x" is how many times faster than real time.`;
const meta = c => c.error ? $('div', {class: 'err'}, c.error) : $('div', {class: 'm'}, `${c.gen_s}s to make ${c.audio_s}s of audio, ${c.rtf}x`);
const player = src => $('audio', {controls: '', preload: 'none', src});
function card(g, v, onlyLine) {
  const id = g.id + '/' + v.id, p = picks[id] || {};
  if (favOnly && !p.star) return null;
  const star = $('button', {class: p.star ? 'on' : '', title: 'star this voice', onclick: () => { p.star = !p.star; picks[id] = p; keep(); render(); }}, p.star ? '★' : '☆');
  const playAll = $('button', {title: 'play every line in order', onclick: e => { const as = [...e.target.closest('.card').querySelectorAll('audio')]; as.forEach((a, i) => a.onended = () => as[i + 1] && as[i + 1].play()); as[0] && as[0].play(); }}, 'Play all');
  const c = $('div', {class: 'card' + (p.star ? ' fav' : '')},
    $('div', {class: 'head'}, $('b', {}, v.label), $('span', {}, playAll, ' ', star)),
    onlyLine == null ? null : $('div', {class: 'desc'}, g.title),
    v.desc ? $('div', {class: 'desc'}, v.desc) : null,
    v.error ? $('div', {class: 'err'}, v.error) : null);
  if (v.ref && onlyLine == null) c.append($('div', {class: 'clip'}, $('div', {class: 't'}, 'Reference clip (used for cloning)'), player(v.ref)));
  for (const cl of v.clips) {
    if (onlyLine != null && cl.line !== onlyLine) continue;
    c.append($('div', {class: 'clip'}, $('div', {class: 't'}, cl.text), cl.file ? player(cl.file) : null, meta(cl)));
  }
  const note = $('textarea', {placeholder: 'notes'});
  note.value = p.note || '';
  note.oninput = () => { p.note = note.value; picks[id] = p; keep(); };
  c.append(note);
  return c;
}
function render() {
  const root = document.getElementById('root'); root.innerHTML = '';
  const line = view.value === 'voice' ? null : +view.value;
  if (line == null) {
    for (const g of DATA.groups) {
      root.append($('h2', {}, g.title), $('div', {class: 'meta'}, [g.model, g.load_s != null && `load ${g.load_s}s`, g.peak_gb && `peak ${g.peak_gb} GB`, g.status !== 'done' && g.status].filter(Boolean).join(' · ')),
        $('div', {class: 'note'}, g.note), g.error ? $('div', {class: 'err'}, g.error) : null,
        $('div', {class: 'grid'}, ...g.voices.map(v => card(g, v, null)).filter(Boolean)));
    }
  } else {
    root.append($('h2', {}, DATA.lines[line]),
      $('div', {class: 'grid'}, ...DATA.groups.flatMap(g => g.voices.map(v => card(g, v, line))).filter(Boolean)));
  }
}
view.onchange = render;
document.getElementById('favonly').onclick = e => { favOnly = !favOnly; e.target.classList.toggle('on', favOnly); render(); };
document.getElementById('copy').onclick = async () => {
  const out = Object.entries(picks).filter(([, p]) => p.star || p.note).map(([id, p]) => `${p.star ? '* ' : '  '}${id}${p.note ? ': ' + p.note : ''}`).join('\n') || '(nothing starred yet)';
  try { await navigator.clipboard.writeText(out); document.getElementById('copied').textContent = 'copied'; }
  catch (e) { prompt('Copy this:', out); }
};
render();
</script></body></html>
"""


def build_page(out: Path, state):
    data = json.dumps(state).replace("</", "<\\/")
    (out / "index.html").write_text(PAGE.replace("__DATA__", data))


if __name__ == "__main__":
    main()
