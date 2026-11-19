'use strict';

// Closing an app you asked her to close (chat.js), after your click. Linux/mango version of
// src/main/apps.js: apps are mango windows grouped by app id; closing asks each window to close
// (like its own close button, so it can still ask to save); forcing kills the process.

const mango = require('./mango');

// never these: Capri herself, T3 Code (the agents run in it), the bar and the lock screen
const KEEP = new Set(['capri', 'com.t3tools.T3Code', 'waybar', 'swaylock']);

const label = (appid) => {
  const last = String(appid).split('.').pop();
  return last.charAt(0).toUpperCase() + last.slice(1);
};

// [{ name, process, label, ids, pids }], one per app id with a window
async function list() {
  const res = await mango.request('get all-clients');
  const apps = new Map();
  for (const c of res?.clients || []) {
    if (!c.appid || KEEP.has(c.appid)) continue;
    const app = apps.get(c.appid) || { name: label(c.appid), process: c.appid, label: c.title || '', ids: [], pids: [] };
    app.ids.push(c.id);
    if (c.pid) app.pids.push(c.pid);
    apps.set(c.appid, app);
  }
  return [...apps.values()];
}

const simple = (text) => String(text || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

async function find(wanted) {
  const key = simple(wanted);
  if (key.length < 2) return null;
  const score = (app) => {
    const names = [simple(app.name), simple(app.process), simple(app.label)].filter(Boolean);
    if (names.includes(key)) return 3;
    if (names.some((n) => n.startsWith(key) || key.startsWith(n))) return 2;
    if (key.length >= 3 && names.some((n) => n.includes(key) || key.includes(n))) return 1;
    return 0;
  };
  const best = (await list()).map((a) => [score(a), a]).filter(([s]) => s > 0).sort((a, b) => b[0] - a[0])[0];
  return best ? best[1] : null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function close(name, { force = false } = {}) {
  const app = (await list()).find((a) => a.process === name);
  if (!app) return { running: false };
  if (force) {
    for (const pid of new Set(app.pids)) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* gone already */ }
    }
    await sleep(600);
  } else {
    for (const id of app.ids) await mango.dispatch('killclient', id).catch(() => {});
    await sleep(2500);
  }
  return { running: Boolean((await list()).find((a) => a.process === name)) };
}

module.exports = { list, find, close };
