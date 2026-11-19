#!/usr/bin/env node
'use strict';

// Fetches Capri's character art into assets/. The art is not in this repository: it belongs to its
// rights holders (see README). Each file comes from upstream (mochiiwuff/capri-desktop) at the
// commit pinned in assets/art.json and must match the SHA-256 listed there, or nothing is kept.
//
//   node scripts/fetch-art.js            fetch what is missing or different
//   node scripts/fetch-art.js --check    only check what is on disk (exit 1 if anything is off)

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets', 'art.json'), 'utf8'));
const repo = new URL(manifest.source).pathname.replace(/^\/|\/$/g, '');
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function onDisk(file) {
  try { return sha256(fs.readFileSync(path.join(ROOT, file))); } catch { return null; }
}

async function fetchOne(file, want) {
  const url = `https://raw.githubusercontent.com/${repo}/${manifest.commit}/${file}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${file}: HTTP ${res.status} from ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const got = sha256(buf);
  if (got !== want) throw new Error(`${file}: hash ${got} does not match ${want}`);
  const dest = path.join(ROOT, file);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest + '.part', buf);
  fs.renameSync(dest + '.part', dest);
}

async function main() {
  const check = process.argv.includes('--check');
  const entries = Object.entries(manifest.files);
  const todo = entries.filter(([file, want]) => onDisk(file) !== want);
  if (check) {
    for (const [file] of todo) console.error(`missing or different: ${file}`);
    console.log(`${entries.length - todo.length}/${entries.length} art files present and verified`);
    process.exit(todo.length ? 1 : 0);
  }
  for (const [file, want] of todo) await fetchOne(file, want);
  console.log(`${todo.length} fetched, ${entries.length - todo.length} already there; ` +
    `all ${entries.length} match ${repo}@${manifest.commit.slice(0, 7)}`);
}

main().catch((err) => { console.error(`fetch-art: ${err.message}`); process.exit(1); });
