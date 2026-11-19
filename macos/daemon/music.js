'use strict';

// Finding music and playing it in Spotify on a Mac. Finding is linux/daemon/music.js as it is
// (Spotify's Web API); the two things that differ are here:
//  - the app's client secret comes from agent-vault's keychain entry, which asks for Touch ID. Once
//    per run of the service: it's kept in memory after that, never written anywhere.
//  - playing: the overlay app tells Spotify to play the link (and opens Spotify first if needed).

const os = require('node:os');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');

const base = require('../../linux/daemon/music');
const native = require('./native');

const VAULT = process.env.CAPRI_VAULT_BIN || path.join(os.homedir(), '.local/bin/agent-vault');
let secret = null;
let asking = null;

base.secrets.read = () => {
  if (secret) return Promise.resolve(secret);
  asking ||= new Promise((resolve) => {
    execFile(VAULT, ['get', 'SPOTIFY_CLIENT_SECRET'], { timeout: 60000 }, (err, out) => {
      asking = null;
      secret = err ? null : String(out).trim() || null;
      resolve(secret);
    });
  });
  return asking;
};

// uri: spotify:track|playlist|album:<id> (a bare 22-char id means a track)
async function play(uri) {
  uri = String(uri);
  if (/^[A-Za-z0-9]{22}$/.test(uri)) uri = `spotify:track:${uri}`;
  if (!/^spotify:(track|playlist|album|artist):[A-Za-z0-9]{22}$/.test(uri)) return { ok: false, error: 'bad uri' };
  return (await native.request('playUri', { uri }, 30000)) || { ok: false, error: 'spotify' };
}

// Spotify's own search page, for when the guess was wrong: you pick there.
async function openSearch(query) {
  const link = `spotify:search:${encodeURIComponent(String(query).slice(0, 200))}`;
  return new Promise((resolve) => {
    const child = spawn('/usr/bin/open', ['-b', 'com.spotify.client', link], { stdio: 'ignore' });
    child.on('error', () => resolve({ ok: false }));
    child.on('exit', (code) => resolve({ ok: code === 0 }));
  });
}

module.exports = { ...base, play, openSearch };
