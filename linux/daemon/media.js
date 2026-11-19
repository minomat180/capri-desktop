'use strict';

// Music control for her chat: skip, go back, pause, play, through MPRIS (playerctl). Spotify
// first; any other player otherwise, never her own webview (WebKit registers itself as one).

const { execFile } = require('child_process');

const ACTIONS = { next: 'next', previous: 'previous', pause: 'pause', play: 'play', playpause: 'play-pause' };

const run = (args) => new Promise((resolve) => {
  execFile('playerctl', args, { timeout: 3000 }, (err, stdout) => resolve(err ? null : String(stdout).trim()));
});

async function player() {
  const list = ((await run(['-l'])) || '').split('\n').map((s) => s.trim()).filter(Boolean)
    .filter((p) => !/capri/i.test(p));
  return list.find((p) => p.startsWith('spotify')) || list[0] || null;
}

async function nowPlaying(p) {
  return run(['-p', p, 'metadata', '--format', '{{artist}} – {{title}}']);
}

// { ok, player, track } or { ok: false, error }
async function control(action) {
  const verb = ACTIONS[action];
  if (!verb) return { ok: false, error: 'unknown action' };
  const p = await player();
  if (!p) return { ok: false, error: 'noplayer' };
  if ((await run(['-p', p, verb])) === null) return { ok: false, error: 'failed', player: p };
  await new Promise((r) => setTimeout(r, 700)); // the new track's metadata lands a beat later
  return { ok: true, player: p.split('.')[0], track: await nowPlaying(p) };
}

async function status() {
  const p = await player();
  if (!p) return null;
  return { player: p.split('.')[0], track: await nowPlaying(p), state: await run(['-p', p, 'status']) };
}

module.exports = { control, status, ACTIONS };
