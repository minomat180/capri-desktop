'use strict';

// What she can feel of this Mac (src/renderer/js/pc.js): the processor, the battery and the
// charger, the network, drives and things you plug in, and the game in front. Everything but the
// processor is what the overlay app last pushed (macos/shell/main.swift, Sensors: the system
// tells it when something changes), so a poll from the renderer costs a read, not a process.

const os = require('node:os');
const native = require('./native');

let before = null;

// Busy since the last call, 0-100 (null the very first time: nothing to compare with).
function cpu() {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) {
    idle += c.times.idle;
    total += c.times.user + c.times.nice + c.times.sys + c.times.irq + c.times.idle;
  }
  const last = before;
  before = { idle, total };
  if (!last || total <= last.total) return null;
  return Math.max(0, Math.min(100, Math.round((1 - (idle - last.idle) / (total - last.total)) * 100)));
}

async function state() {
  const pc = native.pc || {};
  return {
    cpu: cpu(),
    battery: pc.battery ?? null,
    online: pc.online ?? true, // can't tell yet: don't claim she's cut off
    usb: pc.usb || [],
    devices: pc.devices || [],
    game: native.windows?.game || null,
  };
}

module.exports = { state, cpu };
