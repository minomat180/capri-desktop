'use strict';

// Closing an app you asked her to close (chat.js), after your click. macOS twin of
// linux/daemon/apps.js: apps are the running apps with a Dock icon, named by bundle id; closing
// is what Cmd+Q does (so the app can still ask to save); forcing kills it. The overlay app does
// both, and never offers Capri herself, T3 Code (the agents run in it) or the Finder.

const native = require('./native');

// [{ name, process, label }]
async function list() {
  const apps = (await native.request('apps')) || [];
  return apps.map((a) => ({ name: a.name, process: a.process, label: '' }));
}

const simple = (text) => String(text || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

async function find(wanted) {
  const key = simple(wanted);
  if (key.length < 2) return null;
  const score = (app) => {
    const names = [simple(app.name), simple(app.process.split('.').pop())].filter(Boolean);
    if (names.includes(key)) return 3;
    if (names.some((n) => n.startsWith(key) || key.startsWith(n))) return 2;
    if (key.length >= 3 && names.some((n) => n.includes(key) || key.includes(n))) return 1;
    return 0;
  };
  const best = (await list()).map((a) => [score(a), a]).filter(([s]) => s > 0).sort((a, b) => b[0] - a[0])[0];
  return best ? best[1] : null;
}

async function close(name, { force = false } = {}) {
  return (await native.request('closeApp', { name: String(name), force }, 8000)) || { running: true };
}

module.exports = { list, find, close };
