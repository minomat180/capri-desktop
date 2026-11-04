'use strict';

// Her voice: the lines she says, spoken out loud (Piper, local, on this machine).
//
// linux/tts/piper-server.py keeps the voice model loaded (loading it costs ~10 s, speaking a line
// ~0.7 s) and writes one WAV per line into a scratch dir. This module owns that process: it starts
// on the first line she speaks, not at boot, so nothing is paid for if the voice is off, and it is
// restarted if it dies. The renderer fetches the WAV and plays it through her existing volume and
// mute (voice.js), so nothing here ever touches the speakers.
//
// Off by default: config `voice` (false), `voiceModel` (a file in linux/tts/voices).

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('node:crypto');
const { spawn } = require('child_process');
const config = require('./config');

const ROOT = path.join(__dirname, '..', '..');
const TTS = path.join(ROOT, 'linux', 'tts');
const PY = path.join(TTS, 'venv', 'bin', 'python');
const SERVER = path.join(TTS, 'piper-server.py');
const VOICES = path.join(TTS, 'voices');
const OUT = path.join(os.tmpdir(), 'capri-voice');
const KEEP = 20; // WAVs kept around; the renderer may still be fetching the last few

let child = null;
let ready = null;        // resolves once the model is loaded
let pending = new Map(); // id -> { resolve, timer }
let buffer = '';
let starting = false;
let failed = null;       // why the voice is off, if it is

const log = (...a) => console.log('[voice]', ...a);

function voiceFile() {
  const name = config.load().voiceModel || 'en_US-amy-medium';
  const file = path.join(VOICES, `${path.basename(name)}.onnx`);
  return fs.existsSync(file) ? file : null;
}

// Installed voices, for her menu: [{ id, label }]
function voices() {
  try {
    return fs.readdirSync(VOICES).filter((f) => f.endsWith('.onnx')).sort().map((f) => {
      const id = f.replace(/\.onnx$/, '');
      const [locale, who] = id.split('-');
      return { id, label: `${who.replace(/_/g, ' ')} (${locale.replace('_', '-')})` };
    });
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
  const model = voiceFile();
  if (!fs.existsSync(PY)) { failed = 'piper is not installed (linux/tts/venv)'; return null; }
  if (!model) { failed = 'no voice model in linux/tts/voices'; return null; }
  starting = true;
  failed = null;
  ready = new Promise((resolve) => {
    child = spawn(PY, [SERVER, model], { stdio: ['pipe', 'pipe', 'pipe'] });
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
        if (msg.ready) { log(`ready: ${msg.voice}`); done(true); continue; }
        const p = pending.get(msg.id);
        if (p) { clearTimeout(p.timer); pending.delete(msg.id); p.resolve(msg.ok ? msg : null); }
      }
    });
    child.stderr.on('data', (c) => log(String(c).trim()));
    child.on('exit', (code, signal) => {
      log(`piper exited (${signal || code})`);
      child = null;
      if (!settled) { failed = 'piper would not start'; done(false); }
      stop();
    });
    setTimeout(() => { if (!settled) { failed = 'piper took too long to load'; done(false); } }, 60000);
  });
  return ready;
}

function sweep() {
  try {
    const files = fs.readdirSync(OUT).filter((f) => f.endsWith('.wav'))
      .map((f) => ({ f, t: fs.statSync(path.join(OUT, f)).mtimeMs })).sort((a, b) => b.t - a.t);
    for (const { f } of files.slice(KEEP)) fs.unlinkSync(path.join(OUT, f));
  } catch { /* nothing to sweep */ }
}

// Her line as a WAV the renderer can fetch: { url, seconds } or null (voice off, or it failed).
async function say(text) {
  const cfg = config.load();
  if (!cfg.voice) return null;
  const line = String(text || '').replace(/\s+/g, ' ').trim();
  if (!line) return null;
  if (!child && !(await start())) return null;
  else if (!(await ready)) return null;
  const id = crypto.randomBytes(8).toString('hex');
  const file = path.join(OUT, `${id}.wav`);
  const res = await new Promise((resolve) => {
    const timer = setTimeout(() => { pending.delete(id); resolve(null); }, 15000);
    pending.set(id, { resolve, timer });
    try { child.stdin.write(`${JSON.stringify({ id, text: line, path: file })}\n`); }
    catch { clearTimeout(timer); pending.delete(id); resolve(null); }
  });
  if (!res) return null;
  sweep();
  return { url: `/voice/${id}.wav`, seconds: res.seconds, ms: res.ms };
}

// The WAV behind /voice/<id>.wav, or null if that isn't one of ours.
function filePath(name) {
  if (!/^[0-9a-f]{16}\.wav$/.test(name)) return null;
  const file = path.join(OUT, name);
  return fs.existsSync(file) ? file : null;
}

const status = () => ({
  on: Boolean(config.load().voice),
  model: config.load().voiceModel || 'en_US-amy-medium',
  installed: Boolean(fs.existsSync(PY) && voiceFile()),
  running: Boolean(child),
  error: failed,
});

module.exports = { say, voices, status, filePath, stop, start };
