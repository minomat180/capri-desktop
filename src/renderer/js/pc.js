// She lives in your PC, so she feels it: the processor maxed out, the charger, the battery, the
// network, things you plug in (a USB stick, a phone, a controller…) and the games you play.
//
// Linux version: everything comes from one poll of the service (linux/daemon/pc.js, which reads
// /proc, /sys, lsblk and mango), instead of Windows' PowerShell and navigator.getBattery.
// Her menu › React to my PC turns it off.

import { pick, fmt } from './util.js';

const EVERY = 4000;       // one poll of the lot
const HOT = 85;           // % of the processor, for HOT_FOR
const HOT_FOR = 15000;
const HOT_EVERY = 30 * 60 * 1000;
const CHARGER_EVERY = 60 * 1000;
const PLUG_EVERY = 15 * 1000;
const OFFLINE_AFTER = 8000; // a blip isn't worth it
const GAME_AFTER = 6000;    // a game in front this long: you're playing
const GAME_OVER = 8000;     // and gone this long: you're done

const PHONE = /phone|iphone|ipod|ipad|apple|galaxy|samsung|pixel|xiaomi|redmi|poco|oneplus|huawei|honor|motorola|oppo|vivo|realme|nokia|xperia|android|mobile/i;
const PAD = /controller|gamepad|xbox|dualsense|dualshock|joy-?con|8bitdo|stadia/i;
const AUDIO = /headset|headphone|audio|speaker|microphone|mic\b|earbud|airpod|dac\b/i;
const CAMERA = /camera|webcam|cam\b/i;
const INPUT = /keyboard|mouse|trackball|touch|tablet|wacom/i;

// what was plugged in, from what the device calls itself
function kindOf(name = '') {
  if (PAD.test(name)) return 'controller';
  if (PHONE.test(name)) return 'phone';
  if (AUDIO.test(name)) return 'audio';
  if (CAMERA.test(name)) return 'camera';
  if (INPUT.test(name)) return 'input';
  return 'device';
}

export class Pc {
  constructor({ capri, panel, brain, host, voice, chat, guide }) {
    Object.assign(this, { capri, panel, brain, host, voice, chat, guide });
    this.enabled = true;
    this.hotSince = 0;
    this.hot = false;
    this.hotAt = -Infinity;
    this.charging = null;  // null until the first poll: nothing to say about how it already was
    this.chargerAt = -Infinity;
    this.warned = 1;       // lowest battery level she warned about (1: none yet)
    this.online = true;
    this.offSince = 0;
    this.cutOff = false;
    this.drives = null;    // null until the first poll: what's already in isn't news
    this.devices = null;
    this.plugAt = -Infinity;
    this.game = null;
    this.timer = setInterval(() => this.tick().catch(() => {}), EVERY);
  }

  get t() {
    return this.brain.t.pc;
  }

  // not in the middle of something that matters more
  get quiet() {
    return this.enabled && this.capri.mode !== 'alert' && !this.chat?.open && !this.guide?.running
      && !this.capri.stowed && !this.capri.dormant;
  }

  say(line, face = 'smug', hold = 4500) {
    if (this.quiet) this.panel.say({ kind: 'info', face, line, hold });
  }

  async tick() {
    if (!this.enabled) return;
    const s = await this.host.pcState().catch(() => null);
    if (!s) return;
    this.checkCpu(s.cpu);
    if (s.battery) this.checkBattery(s.battery);
    this.checkNet(s.online);
    this.checkDrives(s.usb || []);
    this.checkDevices(s.devices || []);
    this.checkGame(s.game);
  }

  checkCpu(cpu) {
    if (cpu == null) return;
    const now = Date.now();
    if (cpu < HOT) {
      this.hotSince = 0;
      if (this.hot && cpu < 55) {
        this.hot = false;
        if (!this.panel.visible) this.say(pick(this.t.cool), 'calm', 3000);
      }
      return;
    }
    this.hotSince ||= now;
    if (this.hot || now - this.hotSince < HOT_FOR || now - this.hotAt < HOT_EVERY || !this.quiet) return;
    this.hot = true;
    this.hotAt = now;
    this.capri.wake();
    this.say(fmt(pick(this.t.hot), { cpu }), 'wide', 5000);
    this.voice.play('charge');
    this.capri.spark();
  }

  checkBattery({ level, charging }) {
    const now = Date.now();
    if (this.charging === null) { this.charging = charging; return; } // as it was when she started
    if (charging !== this.charging) {
      this.charging = charging;
      if (now - this.chargerAt > CHARGER_EVERY) {
        this.chargerAt = now;
        if (charging) {
          this.warned = 1;
          this.say(pick(this.t.charging), 'laugh', 3500);
          this.voice.play('charge');
          this.capri.pulse();
        } else {
          this.say(pick(this.t.unplugged), 'aside', 3500);
        }
      }
    }
    if (charging) return;
    const at = level <= 0.05 ? 0.05 : level <= 0.15 ? 0.15 : 1;
    if (at >= this.warned) return;
    this.warned = at;
    this.capri.wake();
    this.say(fmt(pick(at === 0.05 ? this.t.critical : this.t.low), { level: Math.round(level * 100) }), 'aside', 6000);
  }

  checkNet(up) {
    const now = Date.now();
    if (up) {
      this.offSince = 0;
      if (!this.online) {
        this.online = true;
        if (this.cutOff) {
          this.cutOff = false;
          this.say(pick(this.t.online), 'grin', 3500);
        }
      }
      return;
    }
    this.online = false;
    this.offSince ||= now;
    if (this.cutOff || now - this.offSince < OFFLINE_AFTER) return;
    this.cutOff = true;
    this.voice.play('error');
    this.say(pick(this.t.offline), 'wide', 5000);
  }

  // a USB stick in or out (she doesn't go looking through it: that's the Windows build's trick)
  checkDrives(list) {
    const ids = list.map((d) => d.id);
    if (this.drives === null) { this.drives = ids; return; }
    const added = list.find((d) => !this.drives.includes(d.id));
    const removed = this.drives.find((id) => !ids.includes(id));
    this.drives = ids;
    if (added) this.say(fmt(pick(this.t.usb), { drive: added.label }), 'smug', 4000);
    else if (removed) this.say(pick(this.t.usbOut), 'aside', 3000);
  }

  checkDevices(list) {
    const ids = list.map((d) => d.id);
    if (this.devices === null) { this.devices = list; return; }
    const was = this.devices;
    this.devices = list;
    const now = Date.now();
    if (now - this.plugAt < PLUG_EVERY) return;
    const added = list.find((d) => !was.some((o) => o.id === d.id));
    const gone = was.find((d) => !ids.includes(d.id));
    const one = added || gone;
    if (!one) return;
    const kind = kindOf(one.name);
    const lines = added ? this.t.plugIn : this.t.plugOut;
    const said = lines[kind] || lines.device;
    if (!said) return;
    this.plugAt = now;
    this.say(fmt(pick(said), { name: one.name }), added ? 'smug' : 'aside', 4000);
  }

  // a game in front: she gets out of the way, and asks about it afterwards
  checkGame(name) {
    const g = this.game;
    const now = Date.now();
    if (name) {
      if (g?.name === name) g.gone = 0;
      else this.game = { name, since: now, gone: 0, said: false, put: false };
    } else if (g) {
      g.gone ||= now;
    }
    const cur = this.game;
    if (!cur) return;
    if (!cur.gone && !cur.said && now - cur.since > GAME_AFTER) {
      cur.said = true;
      this.say(fmt(pick(this.t.game), { game: cur.name }), 'smug', 3000);
      // out of the way while you play
      setTimeout(() => {
        if (this.game === cur && !cur.gone && !this.capri.stowed) { cur.put = true; this.capri.stow?.(); }
      }, 3500);
      return;
    }
    if (cur.gone && now - cur.gone > GAME_OVER) {
      this.game = null;
      if (cur.put && this.capri.stowed) this.capri.unstow?.();
      if (cur.said) this.say(pick(this.t.gameBack), 'grin', 4000);
    }
  }

  stop() {
    clearInterval(this.timer);
  }
}
