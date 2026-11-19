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
  chatBackend: 'claude', // 'claude': `claude -p` with Claude Code's login; 'ollama': ollamaHost below
  claudeModel: 'haiku', // small and quick: she chats, she doesn't code
  spotifyClientId: '314167130a8b43a18fed103b9261f311', // the author's Spotify developer app; use your own id, the secret comes from the keyring
  pcReact: true,       // she reacts to this PC (pc.js): cpu, battery, network, usb, games
  reminders: [],       // the ones she keeps for you (reminders.js)
  chatModel: null,     // the Ollama model (null: the first one installed)
  ollamaHost: '127.0.0.1:11434', // Ollama's default address
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
