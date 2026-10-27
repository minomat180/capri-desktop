'use strict';

// Finding a song and playing it in Spotify, for her chat ("play smooth operator").
//
// Playing is the easy half: the Spotify app takes spotify: links over MPRIS (OpenUri), so
// `playerctl -p spotify open spotify:track:<id>` starts that track. Finding the id is the hard
// half. Spotify's own search API needs a developer app, and since Feb 2026 those need the owner to
// have Premium; so the default here needs no account: a web search restricted to
// open.spotify.com/track pages (DuckDuckGo, through the `ddgs` Python package the web-search skill
// already uses), ranked so the original beats remixes/karaoke/live versions unless you asked for
// one. It can pick wrong, so she offers the runners-up and "search in Spotify" as buttons.

const { execFile, spawn } = require('child_process');

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

async function search(query) {
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
    .map(({ score: _s, ...h }) => h);
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

async function play(id) {
  if (!/^[A-Za-z0-9]{22}$/.test(String(id))) return { ok: false, error: 'bad id' };
  if (!(await ensureSpotify())) return { ok: false, error: 'spotify' };
  if ((await run('playerctl', ['-p', 'spotify', 'open', `spotify:track:${id}`], 5000)) === null) return { ok: false, error: 'spotify' };
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

module.exports = { search, play, openSearch, parseTitle, score };
