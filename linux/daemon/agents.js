'use strict';

// Which window an agent runs in, from its process ancestry: walk up from the agent's pid until a
// pid owns a mango window (the terminal, or T3 Code). Agents inside tmux hang off the tmux server,
// not the terminal, so for those: pane -> session -> attached tmux client -> its terminal.

const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

function parent(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    // the command name can contain spaces and parens: the fields after the last ')' are safe
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return Number(rest[1]) || 0;
  } catch {
    return 0;
  }
}

function comm(pid) {
  try {
    return fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim();
  } catch {
    return '';
  }
}

function ancestry(pid) {
  const chain = [];
  for (let p = Number(pid); p > 1 && chain.length < 64; p = parent(p)) chain.push(p);
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

// -> mango client id, or null
function windowFor(pid, desktop) {
  if (!pid) return null;
  const chain = ancestry(pid);
  for (let i = 0; i < chain.length; i++) {
    const win = desktop.byPid(chain[i]);
    if (win) return win.id;
    if (comm(chain[i]).startsWith('tmux') && i > 0) {
      const client = tmuxClientFor(chain[i - 1]);
      if (client) return windowFor(client, desktop);
      return null;
    }
  }
  return null;
}

module.exports = { windowFor, ancestry };
