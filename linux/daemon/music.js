'use strict';

// Finding music and playing it in Spotify, for her chat ("play smooth operator", "search lofi").
//
// Playing: the Spotify app takes spotify: links over MPRIS (OpenUri), so
// `playerctl -p spotify open spotify:track:<id>` (or :playlist:/:album:) starts it.
// Finding: Spotify's Web API search, with mino's own developer app "glass-player" (client
// credentials: it can search the public catalog, nothing about his account). Client ID is in
// config (spotifyClientId), the secret in the keyring (pi-vault, SPOTIFY_CLIENT_SECRET), read
// with secret-tool, never written anywhere else. Since Feb 2026 dev-mode apps need the owner to
// have Premium and return at most 10 results per search.
// Fallback when the API can't be used: a web search restricted to open.spotify.com/track pages
// (DuckDuckGo via the `ddgs` Python package), slower (7-13 s) and weaker on vague queries.

const { execFile, spawn } = require('child_process');

const config = require('./config');

const run = (cmd, args, ms = 15000) => new Promise((resolve) => {
  execFile(cmd, args, { timeout: ms, maxBuffer: 1 << 20 }, (err, stdout) => resolve(err ? null : String(stdout)));
});

// One web search, as JSON: [{ id, title }] (ids of open.spotify.com/track pages).
const PY = `
import sys, re, json
from ddgs import DDGS
q = sys.argv[1]
out, seen = [], set()
for query in (f"site:open.spotify.com/track {q}", f"{q} spotify track"):
    try:
        results = DDGS().text(query, max_results=10)
    except Exception:
        continue
    for r in results:
        m = re.search(r"open\\.spotify\\.com/(?:intl-[a-z]+/)?track/([A-Za-z0-9]{22})", r.get("href", ""))
        if m and m.group(1) not in seen:
            seen.add(m.group(1))
            out.append({"id": m.group(1), "title": r.get("title", "")})
    if out:
        break
print(json.dumps(out))
`;

// "Cooler Than Me - song and lyrics by Mike Posner, Getter | Spotify..." -> { name, artist }
function parseTitle(raw) {
  const first = String(raw).split(/\|\s*Spotify/)[0];
  const m = /^(.*?)\s+-\s+(?:song(?: and lyrics)?|single|Song, Lyrics, and Music Video) by\s+(.*?)(?:\s*\.\.\.)?\s*$/i.exec(first.trim());
  if (m) return { name: m[1].trim(), artist: m[2].replace(/\s*\.\.\..*$/, '').trim() };
  return { name: first.replace(/\s*\.\.\..*$/, '').trim(), artist: '' };
}

const words = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N} ]+/gu, ' ').split(/\s+/).filter(Boolean);
const VARIANT = ['remix', 'live', 'karaoke', 'instrumental', 'cover', 'acoustic', 'sped', 'slowed', 'reverb', 'edit', 'version', 'drumless', 'tribute', 'style', 'originally', 'performed', 'remastered', 'demo', 'mix'];

// How well a hit matches what you asked for: your words found in its name/artist, minus variants
// you didn't ask for, minus extra featured artists (often remixers).
function score(hit, query) {
  const q = new Set(words(query));
  const name = words(hit.name);
  const artist = words(hit.artist);
  let s = 0;
  for (const w of q) if (name.includes(w) || artist.includes(w)) s += 2;
  for (const w of name) if (!q.has(w)) s -= 0.3; // name words you didn't say
  for (const v of VARIANT) if (name.includes(v) && !q.has(v)) s -= 3;
  s -= Math.max(0, hit.artist.split(',').length - 1) * 0.8;
  return s;
}

// ---------- Spotify Web API ----------

let token = null; // { value, until }

// where the app's client secret comes from (macos/daemon/music.js swaps this for the keychain)
const secrets = {
  read: () => run('secret-tool', ['lookup', 'service', 'pi-vault', 'account', 'SPOTIFY_CLIENT_SECRET'], 5000),
};

async function apiToken() {
  if (token && Date.now() < token.until) return token.value;
  const id = config.load().spotifyClientId;
  if (!id) return null;
  const secret = ((await secrets.read()) || '').trim();
  if (!secret) return null;
  try {
    const res = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`,
      },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(6000),
    });
    const j = await res.json();
    if (!j.access_token) return null;
    token = { value: j.access_token, until: Date.now() + (j.expires_in - 60) * 1000 };
    return token.value;
  } catch {
    return null;
  }
}

// [{ uri, id, kind, name, artist, album }] from the API, or null if the API can't be used.
async function apiSearch(query, kind) {
  const tok = await apiToken();
  if (!tok) return null;
  try {
    const url = `https://api.spotify.com/v1/search?type=${kind}&limit=6&q=${encodeURIComponent(query)}`;
    const res = await fetch(url, { headers: { authorization: `Bearer ${tok}` }, signal: AbortSignal.timeout(6000) });
    if (res.status === 401) token = null;
    if (!res.ok) return null;
    const j = await res.json();
    const items = (j[`${kind}s`]?.items || []).filter(Boolean);
    return items.map((x) => ({
      uri: x.uri,
      id: x.id,
      kind,
      name: x.name,
      artist: kind === 'playlist' ? (x.owner?.display_name || '') : (x.artists || []).map((a) => a.name).join(', '),
      album: kind === 'track' ? x.album?.name || '' : '',
    }));
  } catch {
    return null;
  }
}

// kind: 'track' (default) or 'playlist' ("play some lofi", "a chill playlist")
async function search(query, kind = 'track') {
  const viaApi = await apiSearch(query, kind === 'playlist' ? 'playlist' : 'track');
  if (viaApi) return viaApi.slice(0, 5);
  if (kind === 'playlist') return [];
  return webSearch(query);
}

async function webSearch(query) {
  const out = await run('python3', ['-c', PY, query], 20000);
  let hits;
  try { hits = JSON.parse(out || '[]'); } catch { hits = []; }
  return hits
    .map((h) => ({ id: h.id, ...parseTitle(h.title) }))
    .map((h) => ({ ...h, name: h.name.replace(/\s*-\s*Spotify$/i, '') }))
    .filter((h) => h.name)
    .map((h) => ({ ...h, score: score(h, query) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 4)
    .map(({ score: _s, ...h }) => ({ ...h, uri: `spotify:track:${h.id}`, kind: 'track', album: '' }));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Spotify must be up to take the link: start it if it isn't, and wait for it on the bus.
async function ensureSpotify() {
  const list = () => run('playerctl', ['-l'], 3000).then((o) => (o || '').split('\n').some((p) => p.startsWith('spotify')));
  if (await list()) return true;
  spawn('gtk-launch', ['com.spotify.Client'], { detached: true, stdio: 'ignore' }).unref();
  for (let i = 0; i < 20; i++) {
    await sleep(750);
    if (await list()) { await sleep(1500); return true; } // a beat more: it takes links a little after it shows up
  }
  return false;
}

// uri: spotify:track|playlist|album:<id> (a bare 22-char id means a track)
async function play(uri) {
  uri = String(uri);
  if (/^[A-Za-z0-9]{22}$/.test(uri)) uri = `spotify:track:${uri}`;
  if (!/^spotify:(track|playlist|album|artist):[A-Za-z0-9]{22}$/.test(uri)) return { ok: false, error: 'bad uri' };
  if (!(await ensureSpotify())) return { ok: false, error: 'spotify' };
  if ((await run('playerctl', ['-p', 'spotify', 'open', uri], 5000)) === null) return { ok: false, error: 'spotify' };
  await sleep(1200);
  const now = await run('playerctl', ['-p', 'spotify', 'metadata', '--format', '{{artist}} – {{title}}'], 3000);
  return { ok: true, track: (now || '').trim() };
}

// Spotify's own search page, for when the guess was wrong: you pick there.
async function openSearch(query) {
  if (!(await ensureSpotify())) return { ok: false, error: 'spotify' };
  const ok = (await run('playerctl', ['-p', 'spotify', 'open', `spotify:search:${String(query).slice(0, 200)}`], 5000)) !== null;
  return { ok };
}

module.exports = { search, play, openSearch, parseTitle, score, secrets };
