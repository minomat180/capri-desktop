'use strict';

// The line to the overlay app (macos/shell/main.swift), which is also where everything native
// comes from on a Mac: requests go down its stdin, replies and pushes come back on fd 4, one
// JSON object per line. What it pushes is kept here (`windows`, `pc`), so asking for the state of
// the Mac is a read of what was last said, never a new process.

const { EventEmitter } = require('node:events');

class Native extends EventEmitter {
  constructor() {
    super();
    this.child = null;
    this.seq = 0;
    this.waiting = new Map(); // id -> { resolve, timer }
    this.windows = null;      // the last 'windows' push
    this.pc = null;           // the last 'pc' push
  }

  // child: the overlay process, spawned with stdio ['pipe', ..., ..., 'pipe', 'pipe']
  attach(child) {
    this.child = child;
    let pending = '';
    child.stdio[4].setEncoding('utf8');
    child.stdio[4].on('data', (chunk) => {
      pending += chunk;
      let nl;
      while ((nl = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, nl);
        pending = pending.slice(nl + 1);
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        this.take(msg);
      }
    });
    child.stdin.on('error', () => {}); // it died mid-write: its exit is handled by the service
    child.on('exit', () => {
      if (this.child !== child) return;
      this.child = null;
      for (const [, w] of this.waiting) { clearTimeout(w.timer); w.resolve(null); }
      this.waiting.clear();
    });
  }

  take(msg) {
    if (msg.type === 'reply') {
      const w = this.waiting.get(msg.id);
      if (!w) return;
      this.waiting.delete(msg.id);
      clearTimeout(w.timer);
      w.resolve(msg.value ?? null);
      return;
    }
    if (msg.type === 'windows') this.windows = msg;
    if (msg.type === 'pc') this.pc = msg;
    this.emit(msg.type, msg);
  }

  // something to know, no answer expected
  tell(type, args = {}) {
    this.child?.stdin.write(`${JSON.stringify({ ...args, type })}\n`);
  }

  // resolves with the answer, or null if the overlay isn't there or takes too long
  request(type, args = {}, timeout = 5000) {
    return new Promise((resolve) => {
      if (!this.child) return resolve(null);
      const id = ++this.seq;
      const timer = setTimeout(() => { this.waiting.delete(id); resolve(null); }, timeout);
      this.waiting.set(id, { resolve, timer });
      this.child.stdin.write(`${JSON.stringify({ ...args, id, type })}\n`);
      return undefined;
    });
  }
}

module.exports = new Native();
