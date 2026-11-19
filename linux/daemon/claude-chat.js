'use strict';

// Talking to her through Claude Code: one `claude -p` run per message, with Claude Code's own
// login, so no API key passes through Capri.
// Same shape as src/main/ollama.js: chat({ model, messages }, onDelta, signal) -> full text.
// The run is bare on purpose: no tools, no MCP servers, no skills or slash commands, no settings
// files (so no hooks: the Capri hook in there would make her react to her own chat), no saved
// session.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_MODEL = 'haiku';
const TIMEOUT_MS = 60000;

// The service may run with a short PATH (login item, systemd), so look in the usual places too.
function findClaude() {
  if (process.env.CAPRI_CLAUDE) return process.env.CAPRI_CLAUDE;
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean)
    .concat([path.join(os.homedir(), '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']);
  for (const dir of dirs) {
    const p = path.join(dir, 'claude');
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch {}
  }
  return null;
}

// claude -p takes one prompt: the conversation so far goes into it as a transcript.
function prompt(messages) {
  const turns = messages.filter((m) => m.role !== 'system');
  const last = turns.pop();
  const before = turns.map((m) => `${m.role === 'user' ? 'User' : 'You (Capri)'}: ${m.content}`).join('\n');
  return (before ? `Conversation so far:\n${before}\n\nThe user now says:\n` : '') + (last?.content || '');
}

function chat({ model, messages }, onDelta, signal) {
  const bin = findClaude();
  if (!bin) return Promise.reject(new Error('claude not found'));
  const system = messages.find((m) => m.role === 'system')?.content || '';
  const args = [
    '-p', '--output-format', 'stream-json', '--include-partial-messages', '--verbose',
    '--setting-sources', '', '--tools', '', '--strict-mcp-config', '--disable-slash-commands',
    '--no-session-persistence',
    '--model', model || DEFAULT_MODEL,
    '--system-prompt', system,
    prompt(messages),
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: os.tmpdir(),
      stdio: ['ignore', 'pipe', 'pipe'],
      // belt and braces: even if a hook runs, its Capri events go nowhere
      env: { ...process.env, CAPRI_PORT: '1' },
    });
    let buffer = '';
    let text = '';
    let error = null;
    let stderr = '';
    const timer = setTimeout(() => { error = new Error('claude took too long'); child.kill('SIGTERM'); }, TIMEOUT_MS);
    const abort = () => { error = new Error('stopped'); child.kill('SIGTERM'); };
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        const e = msg.event;
        if (msg.type === 'stream_event' && e?.type === 'content_block_delta' && e.delta?.type === 'text_delta' && e.delta.text) {
          text += e.delta.text;
          onDelta(e.delta.text);
        } else if (msg.type === 'result' && msg.is_error) {
          error = new Error(String(msg.result || msg.subtype || 'the model failed'));
        }
      }
    });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-2000); });
    child.on('error', (err) => { error = err; });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error) return reject(error);
      if (code !== 0 && !text) return reject(new Error(stderr.trim().split('\n').pop() || `claude exited ${code}`));
      resolve(text);
    });
  });
}

module.exports = { chat, DEFAULT_MODEL, findClaude };
