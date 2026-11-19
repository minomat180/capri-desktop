'use strict';

// What Capri needs to know about the desktop on a Mac, in the shape linux/daemon/mango.js gives
// it: the windows on her screen, front first, in her coordinates, and which one has the focus.
// The overlay app works that out (macos/shell/main.swift, pollWindows) and pushes it on change.

const { EventEmitter } = require('node:events');
const native = require('./native');

class Desktop extends EventEmitter {
  constructor() {
    super();
    this.output = null; // the screen she lives on, by name (null: the main one)
    this.owners = new Map(); // pid -> the frontmost window it owns
    this.listener = (snap) => this.changed(snap);
  }

  async start() {
    native.on('windows', this.listener);
  }

  stop() {
    native.off('windows', this.listener);
  }

  get monitor() {
    const s = native.windows?.screen;
    return s ? { name: s.name, x: 0, y: 0, width: s.width, height: s.height, menuBar: s.menuBar } : null;
  }

  changed(snap) {
    this.owners.clear();
    for (const w of snap.wins) if (!this.owners.has(w.pid)) this.owners.set(w.pid, w.id);
    this.emit('windows', {
      fg: snap.fg,
      wins: snap.wins.map(({ id, x, y, w, h, max }) => ({ id, x, y, w, h, max })),
      fullscreen: snap.fullscreen,
    });
  }

  // the window of the app with this pid, if it has one on her screen. An app's windows all belong
  // to one process here, so with several it's the frontmost of them.
  byPid(pid) {
    const id = this.owners.get(pid);
    return id ? { id } : null;
  }

  async cursor() {
    return native.request('cursor', {}, 500);
  }
}

module.exports = { Desktop };
