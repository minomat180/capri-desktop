'use strict';

// Opening an app you asked her to open (chat.js): the apps installed here, read from their
// .desktop entries (the same list rofi shows), launched with gtk-launch. Nothing else runs: she
// can only pick from this list, never a command line.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const DIRS = [
  path.join(os.homedir(), '.local/share/applications'),
  path.join(os.homedir(), '.local/share/flatpak/exports/share/applications'),
  '/var/lib/flatpak/exports/share/applications',
  '/usr/local/share/applications',
  '/usr/share/applications',
];

function parse(file) {
  const out = {};
  let inMain = false;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (line.startsWith('[')) { inMain = line.trim() === '[Desktop Entry]'; continue; }
    if (!inMain) continue;
    const m = /^([A-Za-z]+)=(.*)$/.exec(line);
    if (m && !(m[1] in out)) out[m[1]] = m[2].trim();
  }
  return out;
}

let cache = null;
let cachedAt = 0;

// [{ id, name, generic }], what's launchable, deduped by id (earlier dirs win, like XDG)
function installed() {
  if (cache && Date.now() - cachedAt < 60000) return cache;
  const seen = new Map();
  for (const dir of DIRS) {
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.desktop')); } catch { continue; }
    for (const f of files) {
      const id = f.slice(0, -'.desktop'.length);
      if (seen.has(id)) continue;
      let e;
      try { e = parse(path.join(dir, f)); } catch { continue; }
      seen.set(id, e.Type === 'Application' && e.Name && e.NoDisplay !== 'true' && e.Hidden !== 'true'
        ? { id, name: e.Name, generic: e.GenericName || '' } : null);
    }
  }
  cache = [...seen.values()].filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
  cachedAt = Date.now();
  return cache;
}

const simple = (text) => String(text || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

function find(wanted) {
  const key = simple(wanted);
  if (key.length < 2) return null;
  const score = (a) => {
    const names = [simple(a.name), simple(a.id.split('.').pop()), simple(a.id), simple(a.generic)].filter(Boolean);
    if (names.includes(key)) return 3;
    if (names.some((n) => n.startsWith(key) || key.startsWith(n))) return 2;
    if (key.length >= 3 && names.some((n) => n.includes(key))) return 1;
    return 0;
  };
  const best = installed().map((a) => [score(a), a]).filter(([s]) => s > 0).sort((a, b) => b[0] - a[0])[0];
  return best ? best[1] : null;
}

function open(id) {
  const app = installed().find((a) => a.id === id);
  if (!app) return { ok: false, error: 'not installed' };
  spawn('gtk-launch', [app.id], { detached: true, stdio: 'ignore' }).unref();
  return { ok: true, name: app.name };
}

module.exports = { installed, find, open };
