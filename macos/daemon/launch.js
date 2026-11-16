'use strict';

// Opening an app you asked her to open (chat.js): the apps installed here, which on a Mac are
// the .app bundles in the Applications folders, launched with `open -a`. Nothing else runs: she
// can only pick from this list, never a command line.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const DIRS = [
  path.join(os.homedir(), 'Applications'),
  '/Applications',
  '/Applications/Utilities',
  '/System/Applications',
  '/System/Applications/Utilities',
];

let cache = null;
let cachedAt = 0;

// [{ id, name }], what's launchable, deduped by name (earlier folders win)
function installed() {
  if (cache && Date.now() - cachedAt < 60000) return cache;
  const seen = new Map();
  for (const dir of DIRS) {
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.app') && !f.startsWith('.')); } catch { continue; }
    for (const f of files) {
      const name = f.slice(0, -'.app'.length);
      if (!seen.has(name)) seen.set(name, { id: path.join(dir, f), name });
    }
  }
  cache = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
  cachedAt = Date.now();
  return cache;
}

const simple = (text) => String(text || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

function find(wanted) {
  const key = simple(wanted);
  if (key.length < 2) return null;
  const score = (a) => {
    const name = simple(a.name);
    if (name === key) return 3;
    if (name.startsWith(key) || key.startsWith(name)) return 2;
    if (key.length >= 3 && name.includes(key)) return 1;
    return 0;
  };
  const best = installed().map((a) => [score(a), a]).filter(([s]) => s > 0).sort((a, b) => b[0] - a[0])[0];
  return best ? best[1] : null;
}

function open(id) {
  const app = installed().find((a) => a.id === id);
  if (!app) return { ok: false, error: 'not installed' };
  spawn('/usr/bin/open', ['-a', app.id], { detached: true, stdio: 'ignore' }).unref();
  return { ok: true, name: app.name };
}

module.exports = { installed, find, open };
