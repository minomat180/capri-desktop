'use strict';

// Her voice: the lines she says, spoken out loud, on this machine.
//
// Every line is cached by its text, so her fixed lines (pre-rendered with `capri-ctl voice
// prerender`) play instantly and anything she repeats is free. Only a new line waits.
//
//   Linux  Kokoro (af_heart) through kokoro-onnx, ~5 s a line on the old laptop's CPU (or Piper).
//   macOS  Fish Audio Drama 3 (4-bit) through mlx-audio, cloned from the "drift" clip (a voice
//          designed from a text description with Qwen3-TTS, not a real person's): ~1.4 s a line
//          on an M5 Pro, but 22-28 GB of memory while loaded. So the model is let go after
//          `voiceIdleMinutes` without a line, and a line that would have to wait for it to load
//          is skipped instead of said late (her chat answers still wait). Setup: macos/voice/.
//
// linux/tts/tts-server.py keeps the model loaded and writes one WAV per line. This module owns
// that process: it starts on her first spoken line, not at boot, so nothing is paid for while the
// voice is off, and it restarts if it dies. The renderer fetches the WAV and plays it through her
// existing volume and mute (src/renderer/js/voice.js), so nothing here ever touches the speakers.
//
// Off by default: config `voice` (false), `voiceEngine` ('kokoro', 'piper', or 'mlx' on macOS),
// `voiceModel` (Kokoro voice or Piper model, 'af_heart'), `voiceRef` (mlx reference clip, 'drift'),
// `voiceMlxModel`, `voiceIdleMinutes`.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('node:crypto');
const { spawn } = require('child_process');
const config = require('./config');

const ROOT = path.join(__dirname, '..', '..');
const TTS = path.join(ROOT, 'linux', 'tts');
const SERVER = path.join(TTS, 'tts-server.py');
const VOICES = path.join(TTS, 'voices');
// macOS: the venv, the model's reference clips (<name>.wav + <name>.txt), made by macos/voice/setup.sh
const MLX_HOME = path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'capri', 'voice');
// spoken lines, kept between runs: ~40-250 KB each, her whole fixed set is 10-40 MB
const CACHE = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'capri', 'voice');

const KOKORO = ['af_heart', 'af_bella', 'af_nicole', 'af_sky', 'af_aoede', 'af_kore', 'af_nova',
  'af_river', 'af_sarah', 'af_jessica', 'af_alloy', 'bf_emma', 'bf_alice', 'bf_isabella', 'bf_lily'];

let child = null;
let ready = null;        // resolves true once the model is loaded
let loaded = false;      // the model is in memory and answering
let pending = new Map(); // id -> { resolve, timer }
let buffer = '';
let starting = false;
let failed = null;
let idleTimer = null;

const log = (...a) => console.log('[voice]', ...a);
const safe = (s) => String(s).replace(/[^A-Za-z0-9_-]+/g, '_');

function cfg() {
  const c = config.load();
  const engine = c.voiceEngine || 'kokoro';
  const voice = engine === 'mlx' ? c.voiceRef || 'drift' : c.voiceModel || 'af_heart';
  const model = c.voiceMlxModel || 'mlx-community/fish-audio-drama-3-4bit';
  return {
    engine,
    voice,
    model,
    on: Boolean(c.voice),
    idleMs: Math.max(0, Number(c.voiceIdleMinutes) || 0) * 60000,
    // the cache folder: a different model or clip is a different voice
    key: engine === 'mlx' ? `mlx-${safe(path.basename(model))}-${safe(voice)}` : `${engine}-${safe(voice)}`,
  };
}

const python = (c) => (c.engine === 'mlx'
  ? config.load().voicePython || path.join(MLX_HOME, 'venv', 'bin', 'python')
  : path.join(TTS, 'venv', 'bin', 'python'));
const refFiles = (voice) => ({ wav: path.join(MLX_HOME, `${safe(voice)}.wav`), txt: path.join(MLX_HOME, `${safe(voice)}.txt`) });

// Where a line lives on disk: same voice + same words = same file, always.
function cacheFile(text, { key }) {
  const name = crypto.createHash('sha256').update(`${key}\u0000${text}`).digest('hex').slice(0, 24);
  return path.join(CACHE, key, `${name}.wav`);
}

function installed() {
  const c = cfg();
  if (!fs.existsSync(python(c))) return false;
  if (c.engine === 'mlx') { const r = refFiles(c.voice); return fs.existsSync(r.wav) && fs.existsSync(r.txt); }
  return c.engine === 'kokoro'
    ? fs.existsSync(path.join(VOICES, 'kokoro-v1.0.onnx')) && fs.existsSync(path.join(VOICES, 'voices-v1.0.bin'))
    : fs.existsSync(path.join(VOICES, `${path.basename(c.voice)}.onnx`));
}

function voices() {
  const { engine } = cfg();
  if (engine === 'kokoro') return KOKORO.map((id) => ({ id, label: `${id.slice(3)} (${id[0] === 'a' ? 'US' : 'GB'})` }));
  const [dir, ext] = engine === 'mlx' ? [MLX_HOME, '.wav'] : [VOICES, '.onnx'];
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith(ext) && !f.startsWith('kokoro'))
      .map((f) => ({ id: f.slice(0, -ext.length), label: f.slice(0, -ext.length) }));
  } catch {
    return [];
  }
}

function stop() {
  clearTimeout(idleTimer);
  if (child) { child.kill('SIGTERM'); child = null; }
  for (const { resolve, timer } of pending.values()) { clearTimeout(timer); resolve(null); }
  pending.clear();
  ready = null;
  loaded = false;
  starting = false;
}

// Let the model go after a while without a line (macOS: it holds 22-28 GB).
function idle() {
  clearTimeout(idleTimer);
  const { idleMs } = cfg();
  if (!idleMs || !child) return;
  idleTimer = setTimeout(() => {
    if (pending.size) return idle();
    log(`no line for ${Math.round(idleMs / 60000)} min: letting the model go`);
    stop();
  }, idleMs);
}

function start() {
  if (child || starting) return ready;
  const c = cfg();
  const py = python(c);
  if (!fs.existsSync(py)) {
    failed = c.engine === 'mlx' ? 'the voice venv is missing (run macos/voice/setup.sh)' : 'the tts venv is missing (see linux/tts/README.md)';
    return null;
  }
  if (!installed()) { failed = c.engine === 'mlx' ? `no reference clip "${c.voice}" in ${MLX_HOME}` : `no model for ${c.engine} in linux/tts/voices`; return null; }
  starting = true;
  failed = null;
  ready = new Promise((resolve) => {
    let args;
    if (c.engine === 'mlx') {
      const r = refFiles(c.voice);
      args = ['--engine', 'mlx', '--voice', c.model, '--ref', r.wav, '--ref-text', r.txt];
    } else {
      args = ['--engine', c.engine, '--voice', c.engine === 'kokoro' ? c.voice : path.join(VOICES, `${path.basename(c.voice)}.onnx`)];
    }
    child = spawn(py, [SERVER, ...args], { stdio: ['pipe', 'pipe', 'pipe'], cwd: os.tmpdir() });
    let settled = false;
    let loadTimer = null;
    const done = (ok) => { if (!settled) { settled = true; clearTimeout(loadTimer); starting = false; loaded = ok; resolve(ok); if (ok) idle(); } };
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if ('ready' in msg) {
          if (msg.ready) log(`ready: ${msg.engine}/${msg.voice}`);
          else failed = msg.error || 'the voice would not load';
          done(Boolean(msg.ready));
          continue;
        }
        const p = pending.get(msg.id);
        if (p) { clearTimeout(p.timer); pending.delete(msg.id); p.resolve(msg.ok ? msg : null); }
      }
    });
    child.stderr.on('data', (chunk) => {
      // mlx-audio and Hugging Face print progress bars; keep only real lines
      for (const l of String(chunk).split(/[\r\n]+/)) if (l.trim() && !/\d+%\|/.test(l)) log(l.trim());
    });
    child.on('exit', (code, signal) => {
      log(`tts exited (${signal || code})`);
      child = null;
      if (!settled) { failed = 'the voice would not start'; done(false); }
      stop();
    });
    // a big model from disk plus its first compile: give it time
    loadTimer = setTimeout(() => { if (!settled) { failed = 'the voice took too long to load'; done(false); stop(); } }, c.engine === 'mlx' ? 300000 : 90000);
  });
  return ready;
}

const clean = (text) => String(text || '').replace(/\s+/g, ' ').trim();

// Make the WAV for a line (or reuse the cached one). Resolves the file path, or null.
async function render(text, opts = {}) {
  const line = clean(text);
  if (!line) return null;
  const where = cfg();
  const file = cacheFile(line, where);
  if (fs.existsSync(file)) return file;
  if (!opts.force && !where.on) return null;
  if (opts.warmOnly && !loaded) { start(); return null; } // too late by the time it loads: warm up for the next one
  if (!child && !(await start())) return null;
  if (!(await ready)) return null;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const id = crypto.randomBytes(8).toString('hex');
  const tmp = file.replace(/\.wav$/, `.${id}.part.wav`); // .wav: soundfile picks its format from the extension
  const res = await new Promise((resolve) => {
    const timer = setTimeout(() => { pending.delete(id); resolve(null); }, 120000);
    pending.set(id, { resolve, timer });
    try { child.stdin.write(`${JSON.stringify({ id, text: line, path: tmp })}\n`); }
    catch { clearTimeout(timer); pending.delete(id); resolve(null); }
  });
  idle();
  if (!res) { try { fs.unlinkSync(tmp); } catch { /* nothing to clean */ } return null; }
  try { fs.renameSync(tmp, file); } catch { return null; } // whole file or none: never a half-written one
  return file;
}

// Her line, as something the renderer can fetch: { url, cached } or null (voice off / it failed /
// a passing line while the model is still loading). `kind` 'chat' (her answer) always waits.
async function say(text, { kind } = {}) {
  if (!cfg().on) return null;
  const line = clean(text);
  const where = cfg();
  const wanted = cacheFile(line, where);
  const had = fs.existsSync(wanted);
  const file = await render(line, { warmOnly: kind !== 'chat' && where.idleMs > 0 });
  if (!file) return null;
  return { url: `/voice/${path.basename(path.dirname(file))}/${path.basename(file)}`, cached: had };
}

// Her fixed lines, made once so they play instantly afterwards. onStep(done, total, text).
async function prerender(lines, onStep) {
  const todo = [...new Set(lines.map(clean).filter(Boolean))];
  let made = 0;
  let had = 0;
  for (const [i, line] of todo.entries()) {
    const existed = fs.existsSync(cacheFile(line, cfg()));
    const file = await render(line, { force: true });
    if (existed) had += 1; else if (file) made += 1;
    onStep?.(i + 1, todo.length, line);
  }
  return { total: todo.length, made, had };
}

// The WAV behind /voice/<dir>/<file>.wav, or null if that isn't one of ours.
function filePath(dir, name) {
  if (!/^[a-z]+-[A-Za-z0-9_-]+$/.test(dir) || !/^[0-9a-f]{24}\.wav$/.test(name)) return null;
  const file = path.join(CACHE, dir, name);
  return file.startsWith(CACHE) && fs.existsSync(file) ? file : null;
}

function status() {
  const { engine, voice, model, on, key, idleMs } = cfg();
  let cached = 0;
  try { cached = fs.readdirSync(path.join(CACHE, key)).filter((f) => f.endsWith('.wav')).length; } catch { /* none yet */ }
  return {
    on, engine, voice, model: engine === 'mlx' ? model : undefined, installed: installed(),
    running: Boolean(child), loaded, idleMinutes: idleMs / 60000, cached, error: failed,
  };
}

// Pick a voice from voices(): the setting it belongs in depends on the engine.
function pick(id) {
  return cfg().engine === 'mlx' ? { voiceRef: safe(id) } : { voiceModel: String(id) };
}

module.exports = { say, prerender, voices, status, filePath, stop, start, pick };
