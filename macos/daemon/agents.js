'use strict';

// Which window an agent runs in, from its process ancestry: walk up from the agent's pid until a
// pid owns a window (Terminal, or T3 Code). macOS twin of linux/daemon/agents.js: no /proc here,
// so the process table comes from one `ps`, kept for a couple of seconds, and which app an agent
// belongs to is remembered (it doesn't change while the agent lives).

const path = require('node:path');
const { execFileSync } = require('node:child_process');

let table = null;
let tableAt = 0;

function procs() {
  if (table && Date.now() - tableAt < 2000) return table;
  table = new Map();
  tableAt = Date.now();
  let out = '';
  try {
    out = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,comm='], { encoding: 'utf8', timeout: 2000, maxBuffer: 8 << 20 });
  } catch {
    return table;
  }
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m) table.set(Number(m[1]), { parent: Number(m[2]), comm: path.basename(m[3]) });
  }
  return table;
}

function ancestry(pid) {
  const all = procs();
  const chain = [];
  for (let p = Number(pid); p > 1 && chain.length < 64; p = all.get(p)?.parent || 0) chain.push(p);
  return chain;
}

function tmux(args) {
  try {
    return execFileSync('tmux', args, { encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

// the pid of a tmux client attached to the session holding this pane pid
function tmuxClientFor(panePid) {
  const panes = tmux(['list-panes', '-a', '-F', '#{pane_pid} #{session_name}']);
  const session = panes.split('\n').map((l) => l.split(' ')).find(([p]) => Number(p) === panePid)?.[1];
  if (!session) return 0;
  const clients = tmux(['list-clients', '-t', session, '-F', '#{client_activity} #{client_pid}']);
  const latest = clients.split('\n').filter(Boolean).map((l) => l.split(' ').map(Number)).sort((a, b) => b[0] - a[0])[0];
  return latest?.[1] || 0;
}

const owners = new Map(); // agent pid -> { pid: the app's pid, at }
const REMEMBER_MS = 60000;

// the pid of the app this agent runs in, or 0
function ownerOf(pid, desktop) {
  const chain = ancestry(pid);
  const all = procs();
  for (let i = 0; i < chain.length; i++) {
    if (desktop.byPid(chain[i])) return chain[i];
    if ((all.get(chain[i])?.comm || '').startsWith('tmux') && i > 0) {
      const client = tmuxClientFor(chain[i - 1]);
      return client ? ownerOf(client, desktop) : 0;
    }
  }
  return 0;
}

// -> window id, or null
function windowFor(pid, desktop) {
  if (!pid) return null;
  const known = owners.get(pid);
  let owner = known && Date.now() - known.at < REMEMBER_MS ? known.pid : 0;
  if (!owner) {
    owner = ownerOf(pid, desktop);
    if (owner) owners.set(pid, { pid: owner, at: Date.now() });
    if (owners.size > 200) owners.delete(owners.keys().next().value);
  }
  return desktop.byPid(owner)?.id ?? null;
}

module.exports = { windowFor, ancestry };
