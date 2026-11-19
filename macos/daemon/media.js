'use strict';

// Music control for her chat: skip, go back, pause, play. On a Mac the overlay app tells Spotify
// (or Music) directly, and only if one of them is already open. The first time, macOS asks
// whether Capri may control it.

const native = require('./native');

const ACTIONS = { next: 'next', previous: 'previous', pause: 'pause', play: 'play', playpause: 'play-pause' };

// { ok, player, track } or { ok: false, error }
async function control(action) {
  if (!ACTIONS[action]) return { ok: false, error: 'unknown action' };
  return (await native.request('media', { action }, 10000)) || { ok: false, error: 'failed' };
}

async function status() {
  return native.request('mediaStatus', {}, 10000);
}

module.exports = { control, status, ACTIONS };
