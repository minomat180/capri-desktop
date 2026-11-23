'use strict';

// Her voice: the lines she says, spoken out loud, on this machine.
//
// Kokoro (af_heart) sounds right but costs ~5 s a line on this laptop's CPU, so every line is
// cached by its text: her fixed lines (223 of them, pre-rendered with `capri-ctl voice prerender`)
// play instantly, and anything she repeats is free. Only a new chat answer waits.
//
// linux/tts/tts-server.py keeps the model loaded (loading costs 4-11 s) and writes one WAV per
// line. This module owns that process: it starts on her first spoken line, not at boot, so
// nothing is paid for while the voice is off, and it restarts if it dies. The renderer fetches the
// WAV and plays it through her existing volume and mute (src/renderer/js/voice.js), so nothing
// here ever touches the speakers.
//
// Off by default: config `voice` (false), `voiceEngine` ('kokoro'), `voiceModel` ('af_heart').

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('node:crypto');
const { spawn } = require('child_process');
const config = require('./config');

const ROOT = path.join(__dirname, '..', '..');
const TTS = path.join(ROOT, 'linux', 'tts');
const PY = path.join(TTS, 'venv', 'bin', 'python');
const SERVER = path.join(TTS, 'tts-server.py');
const VOICES = path.join(TTS, 'voices');
// spoken lines, kept between runs: ~40 KB each, her whole fixed set is about 10 MB
const CACHE = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'capri', 'voice');

const KOKORO = ['af_heart', 'af_bella', 'af_nicole', 'af_sky', 'af_aoede', 'af_kore', 'af_nova',
  'af_river', 'af_sarah', 'af_jessica', 'af_alloy', 'bf_emma', 'bf_alice', 'bf_isabella', 'bf_lily'];

let child = null;
let ready = null;        // resolves true once the model is loaded
let pending = new Map(); // id -> { resolve, timer }
let buffer = '';
let starting = false;
let failed = null;

const log = (...a) => console.log('[voice]', ...a);
const cfg = () => {
  const c = config.load();
  return { engine: c.voiceEngine || 'kokoro', voice: c.voiceModel || 'af_heart', on: Boolean(c.voice) };
};

// Where a line lives on disk: same voice + same words = same file, always.
function cacheFile(text, { engine, voice }) {
  const key = crypto.createHash('sha256').update(`${engine}\u0000${voice}\u0000${text}`).digest('hex').slice(0, 24);
  return path.join(CACHE, `${engine}-${voice}`, `${key}.wav`);
}

function installed() {
  if (!fs.existsSync(PY)) return false;
  const { engine, voice } = cfg();
  return engine === 'kokoro'
    ? fs.existsSync(path.join(VOICES, 'kokoro-v1.0.onnx')) && fs.existsSync(path.join(VOICES, 'voices-v1.0.bin'))
    : fs.existsSync(path.join(VOICES, `${path.basename(voice)}.onnx`));
}

function voices() {
  const { engine } = cfg();
  if (engine === 'kokoro') return KOKORO.map((id) => ({ id, label: `${id.slice(3)} (${id[0] === 'a' ? 'US' : 'GB'})` }));
  try {
    return fs.readdirSync(VOICES).filter((f) => f.endsWith('.onnx') && !f.startsWith('kokoro'))
      .map((f) => ({ id: f.replace(/\.onnx$/, ''), label: f.replace(/\.onnx$/, '') }));
  } catch {
    return [];
  }
}

function stop() {
  if (child) { child.kill('SIGTERM'); child = null; }
  for (const { resolve, timer } of pending.values()) { clearTimeout(timer); resolve(null); }
  pending.clear();
  ready = null;
  starting = false;
}

function start() {
  if (child || starting) return ready;
  const { engine, voice } = cfg();
  if (!fs.existsSync(PY)) { failed = 'the tts venv is missing (see linux/tts/README.md)'; return null; }
  if (!installed()) { failed = `no model for ${engine} in linux/tts/voices`; return null; }
  starting = true;
  failed = null;
  ready = new Promise((resolve) => {
    const voiceArg = engine === 'kokoro' ? voice : path.join(VOICES, `${path.basename(voice)}.onnx`);
    child = spawn(PY, [SERVER, '--engine', engine, '--voice', voiceArg], { stdio: ['pipe', 'pipe', 'pipe'] });
    let settled = false;
    const done = (ok) => { if (!settled) { settled = true; starting = false; resolve(ok); } };
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
    child.stderr.on('data', (c) => log(String(c).trim()));
    child.on('exit', (code, signal) => {
      log(`tts exited (${signal || code})`);
      child = null;
      if (!settled) { failed = 'the voice would not start'; done(false); }
      stop();
    });
    setTimeout(() => { if (!settled) { failed = 'the voice took too long to load'; done(false); } }, 90000);
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
  if (!child && !(await start())) return null;
  if (!(await ready)) return null;
  const id = crypto.randomBytes(8).toString('hex');
  const tmp = file.replace(/\.wav$/, `.${id}.part.wav`); // .wav: soundfile picks its format from the extension
  const res = await new Promise((resolve) => {
    const timer = setTimeout(() => { pending.delete(id); resolve(null); }, 60000);
    pending.set(id, { resolve, timer });
    try { child.stdin.write(`${JSON.stringify({ id, text: line, path: tmp })}\n`); }
    catch { clearTimeout(timer); pending.delete(id); resolve(null); }
  });
  if (!res) { try { fs.unlinkSync(tmp); } catch { /* nothing to clean */ } return null; }
  try { fs.renameSync(tmp, file); } catch { return null; } // whole file or none: never a half-written one
  return file;
}

// Her line, as something the renderer can fetch: { url, cached } or null (voice off / it failed).
async function say(text) {
  if (!cfg().on) return null;
  const line = clean(text);
  const where = cfg();
  const wanted = cacheFile(line, where);
  const had = fs.existsSync(wanted);
  const file = await render(line);
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
  const { engine, voice, on } = cfg();
  let cached = 0;
  try { cached = fs.readdirSync(path.join(CACHE, `${engine}-${voice}`)).filter((f) => f.endsWith('.wav')).length; } catch { /* none yet */ }
  return { on, engine, voice, installed: installed(), running: Boolean(child), cached, error: failed };
}

module.exports = { say, prerender, voices, status, filePath, stop, start };
