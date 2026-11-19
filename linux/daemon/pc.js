'use strict';

// What she can feel of this PC (src/renderer/js/pc.js): the processor, the battery and the
// charger, the network, USB sticks and things you plug in, and the game in front. The Windows
// build reads these from PowerShell and `navigator.getBattery`; here they come from /proc and
// /sys, lsblk and mango. All polled, nothing persistent: one call answers with everything.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const mango = require('./mango');

const run = (cmd, args, ms = 3000) => new Promise((resolve) => {
  execFile(cmd, args, { timeout: ms, maxBuffer: 1 << 20 }, (err, out) => resolve(err ? null : String(out)));
});

const read = (file) => { try { return fs.readFileSync(file, 'utf8').trim(); } catch { return null; } };
const num = (file) => { const v = read(file); return v === null ? null : Number(v); };

// ---------- the processor ----------

let before = null;

// Busy since the last call, 0-100 (null the very first time: nothing to compare with).
function cpu() {
  const stat = read('/proc/stat');
  if (!stat) return null;
  const line = stat.split('\n')[0].split(/\s+/).slice(1).map(Number);
  if (!line.length) return null;
  const idle = line[3] + (line[4] || 0); // idle + iowait
  const total = line.reduce((a, b) => a + b, 0);
  const last = before;
  before = { idle, total };
  if (!last) return null;
  const dTotal = total - last.total;
  const dIdle = idle - last.idle;
  if (dTotal <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((1 - dIdle / dTotal) * 100)));
}

// ---------- the battery and the charger ----------

const SUPPLY = '/sys/class/power_supply';

// { level: 0-1, charging } across both packs (this ThinkPad has two), or null on a desktop.
function battery() {
  let names = [];
  try { names = fs.readdirSync(SUPPLY); } catch { return null; }
  const packs = names.filter((n) => /^BAT/i.test(n) && read(path.join(SUPPLY, n, 'present')) !== '0');
  if (!packs.length) return null;
  let now = 0;
  let full = 0;
  for (const n of packs) {
    const dir = path.join(SUPPLY, n);
    const e = num(path.join(dir, 'energy_now')) ?? num(path.join(dir, 'charge_now'));
    const f = num(path.join(dir, 'energy_full')) ?? num(path.join(dir, 'charge_full'));
    if (e !== null && f) { now += e; full += f; }
  }
  if (!full) return null;
  // the charger: any mains supply online, or a pack saying it's charging
  const mains = names.filter((n) => read(path.join(SUPPLY, n, 'type')) === 'Mains');
  const charging = mains.some((n) => read(path.join(SUPPLY, n, 'online')) === '1')
    || packs.some((n) => read(path.join(SUPPLY, n, 'status')) === 'Charging');
  return { level: Math.max(0, Math.min(1, now / full)), charging };
}

// ---------- the network ----------

// Online if any real interface (not loopback, not a docker bridge) is up with a carrier.
function online() {
  try {
    return fs.readdirSync('/sys/class/net').some((n) => {
      if (n === 'lo' || /^(docker|br-|veth|virbr)/.test(n)) return false;
      return read(`/sys/class/net/${n}/operstate`) === 'up' && read(`/sys/class/net/${n}/carrier`) === '1';
    });
  } catch {
    return true; // can't tell: don't claim she's cut off
  }
}

// ---------- what you plug in ----------

// Removable drives that are mounted, as [{ id, label, mount }] (the Windows build lists letters).
async function drives() {
  const out = await run('lsblk', ['-J', '-o', 'NAME,RM,TYPE,LABEL,MOUNTPOINT,TRAN']);
  if (!out) return [];
  let tree;
  try { tree = JSON.parse(out); } catch { return []; }
  const found = [];
  const walk = (nodes, removable) => {
    for (const n of nodes || []) {
      const rm = removable || n.rm === true || n.rm === '1' || n.tran === 'usb';
      if (rm && n.mountpoint && n.type === 'part') {
        found.push({ id: n.name, label: n.label || path.basename(n.mountpoint), mount: n.mountpoint });
      }
      walk(n.children, rm);
    }
  };
  walk(tree.blockdevices, false);
  return found;
}

// USB devices now attached: [{ id, name, kind }]. Compared between calls (pc.js) to notice one
// coming or going; the name is what the device calls itself.
function usbDevices() {
  const base = '/sys/bus/usb/devices';
  let names = [];
  try { names = fs.readdirSync(base); } catch { return []; }
  const out = [];
  for (const n of names) {
    if (!/^\d+-[\d.]+$/.test(n)) continue; // a device, not an interface or a root hub
    const dir = path.join(base, n);
    const product = read(path.join(dir, 'product'));
    const cls = read(path.join(dir, 'bDeviceClass'));
    if (!product) continue;
    out.push({ id: `${read(path.join(dir, 'idVendor'))}:${read(path.join(dir, 'idProduct'))}:${n}`, name: product, cls });
  }
  return out;
}

// ---------- the game in front ----------

const GAMEY = /steam|lutris|wine|proton|minecraft|gamescope|heroic|retroarch|dolphin-emu|ppsspp|rpcs3/i;

// A fullscreen window that looks like a game, as its name, or null.
async function game() {
  const res = await mango.request('get all-clients').catch(() => null);
  const win = (res?.clients || []).find((c) => c.fullscreen && c.focused);
  if (!win) return null;
  const id = String(win.appid || '');
  const title = String(win.title || '');
  if (!GAMEY.test(id) && !GAMEY.test(title)) return null;
  return title || id;
}

// Everything at once, for one poll from the renderer.
async function state() {
  const [usb, playing] = await Promise.all([drives(), game()]);
  return { cpu: cpu(), battery: battery(), online: online(), usb, devices: usbDevices(), game: playing };
}

module.exports = { state, cpu, battery, online, drives, usbDevices, game };
