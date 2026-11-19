'use strict';

// mango IPC, spoken directly over its Unix socket (what `mmsg` does): one command per
// connection, a newline-terminated line out, JSON lines back. `get` answers once, `watch`
// keeps streaming. Needs mango 0.15+ for `get cursorpos`.

const net = require('node:net');
const { EventEmitter } = require('node:events');

function socketPath() {
  const path = process.env.MANGO_INSTANCE_SIGNATURE;
  if (!path) throw new Error('MANGO_INSTANCE_SIGNATURE is not set: not running inside mango?');
  return path;
}

// One-shot command: resolves with the parsed JSON answer (or the raw text if it isn't JSON).
function request(command, { timeout = 1500 } = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(socketPath());
    let buf = '';
    const timer = setTimeout(() => { sock.destroy(); reject(new Error(`mango: ${command}: timeout`)); }, timeout);
    sock.setEncoding('utf8');
    sock.on('connect', () => sock.write(`${command}\n`));
    sock.on('data', (d) => { buf += d; });
    sock.on('error', (err) => { clearTimeout(timer); reject(err); });
    sock.on('close', () => {
      clearTimeout(timer);
      const text = buf.trim();
      try { resolve(text ? JSON.parse(text) : null); } catch { resolve(text); }
    });
  });
}

const dispatch = (func, clientId) => request(`dispatch ${func}${clientId != null ? ` client,${clientId}` : ''}`);

// Streaming command: emits 'data' for each JSON line; reconnects if mango drops it.
function watch(command) {
  const ee = new EventEmitter();
  let sock = null;
  let stopped = false;
  const open = () => {
    let buf = '';
    sock = net.createConnection(socketPath());
    sock.setEncoding('utf8');
    sock.on('connect', () => sock.write(`${command}\n`));
    sock.on('data', (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try { ee.emit('data', JSON.parse(line)); } catch { /* not JSON, skip */ }
      }
    });
    sock.on('error', (err) => ee.emit('error', err));
    sock.on('close', () => { if (!stopped) setTimeout(open, 1000); });
  };
  open();
  ee.stop = () => { stopped = true; sock?.destroy(); };
  return ee;
}

// What Capri needs to know about the desktop: the windows on her monitor that are on screen,
// front first, in her coordinates, and which one has the focus. Front-first is a guess (mango
// doesn't report stacking): floating windows over tiled ones, the focused one first of its kind.
class Desktop extends EventEmitter {
  constructor({ ignoreAppIds = [] } = {}) {
    super();
    this.ignore = new Set(ignoreAppIds);
    this.clients = [];
    this.monitors = [];
    this.output = null; // the monitor Capri lives on (name), null: the focused one at start
    this.watchers = [];
  }

  async start() {
    const [clients, monitors] = await Promise.all([request('get all-clients'), request('get all-monitors')]);
    this.clients = clients?.clients || [];
    this.monitors = monitors?.monitors || [];
    if (!this.output) this.output = this.monitors.find((m) => m.active)?.name || this.monitors[0]?.name || null;
    const cw = watch('watch all-clients');
    cw.on('data', (d) => { this.clients = d.clients || []; this.changed(); });
    const mw = watch('watch all-monitors');
    mw.on('data', (d) => { this.monitors = d.monitors || []; this.changed(); });
    for (const w of [cw, mw]) w.on('error', (err) => this.emit('error', err));
    this.watchers.push(cw, mw);
    this.changed();
  }

  stop() {
    for (const w of this.watchers) w.stop();
  }

  get monitor() {
    return this.monitors.find((m) => m.name === this.output) || this.monitors[0] || null;
  }

  changed() {
    const snap = this.snapshot();
    const key = JSON.stringify(snap);
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.emit('windows', snap);
  }

  snapshot() {
    const m = this.monitor;
    if (!m) return { fg: 0, wins: [], fullscreen: false };
    const mine = this.clients.filter((c) => c.monitor === m.name && c.is_visible && !c.is_minimized
      && !this.ignore.has(c.appid));
    const rank = (c) => (c.is_fullscreen ? 0 : c.is_floating ? 1 : 2) * 2 + (c.is_focused ? 0 : 1);
    const wins = mine
      .sort((a, b) => rank(a) - rank(b))
      .map((c) => ({
        id: c.id,
        x: c.x - m.x,
        y: c.y - m.y,
        w: c.width,
        h: c.height,
        max: Boolean(c.is_fullscreen || c.is_maximized),
      }));
    const focused = mine.find((c) => c.is_focused);
    return { fg: focused?.id || 0, wins, fullscreen: Boolean(focused?.is_fullscreen) };
  }

  // the client with this pid, if it's a window
  byPid(pid) {
    return this.clients.find((c) => c.pid === pid) || null;
  }

  async cursor() {
    const p = await request('get cursorpos', { timeout: 500 });
    const m = this.monitor;
    if (!p || typeof p.x !== 'number' || !m) return null;
    const x = p.x - m.x;
    const y = p.y - m.y;
    return { x, y, inside: p.monitor === m.name && x >= 0 && y >= 0 && x < m.width && y < m.height };
  }
}

module.exports = { request, dispatch, watch, Desktop };
