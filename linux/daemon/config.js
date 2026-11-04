'use strict';

// Capri's settings on Linux: ~/.config/capri/config.json. Same keys as upstream's Electron
// config (src/main/config.js), plus where her chat model lives.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DIR = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'capri');
const FILE = path.join(DIR, 'config.json');

const DEFAULTS = {
  scale: 0.6,
  muted: false,
  volume: 0.7,
  lang: 'en',          // English only on this build
  output: null,        // mango output name she lives on (null: the focused one at start)
  wander: true,
  possess: true,
  visible: true,
  welcomed: false,
  linked: false,
  chatBackend: 'pi',   // 'pi': any model pi has, with pi's logins; 'ollama': ollamaHost below
  piModel: 'anthropic/claude-haiku-4-5', // small and quick: she chats, she doesn't code
  voice: false,        // she speaks her lines out loud (local, see linux/tts/)
  voiceEngine: 'kokoro',
  voiceModel: 'af_heart',
  spotifyClientId: '314167130a8b43a18fed103b9261f311', // mino's dev app "glass-player"; secret in the keyring
  chatModel: null,     // the Ollama model (null: the first one installed)
  ollamaHost: '127.0.0.1:11434', // minomat over Thunderbolt
};

let cache = null;

function load() {
  if (cache) return cache;
  try {
    cache = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) };
  } catch {
    cache = { ...DEFAULTS };
  }
  return cache;
}

function save(patch) {
  cache = { ...load(), ...patch };
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(cache, null, 2));
  } catch (err) {
    console.error('[capri] could not save config:', err.message);
  }
  return cache;
}

module.exports = { load, save, DEFAULTS, DIR, FILE };
