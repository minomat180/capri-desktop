'use strict';

// Talking to her through pi: one `pi -p` run per message, with pi's own logins
// (~/.pi/agent/auth.json), so any model pi has works here and no API key passes through Capri.
// Same shape as src/main/ollama.js: chat({ model, messages }, onDelta, signal) -> full text.
// The run is bare on purpose: no tools, no extensions (the Capri bridge in there would make her
// react to her own chat), no skills, no AGENTS.md, no saved session.

const { spawn } = require('child_process');
const os = require('os');
const path = require('path');

const PI = process.env.CAPRI_PI || path.join(os.homedir(), '.pi/agent/bin/pi');
const DEFAULT_MODEL = 'anthropic/claude-haiku-4-5';
const TIMEOUT_MS = 60000;

// pi -p takes one prompt: the conversation so far goes into it as a transcript.
function prompt(messages) {
  const turns = messages.filter((m) => m.role !== 'system');
  const last = turns.pop();
  const before = turns.map((m) => `${m.role === 'user' ? 'User' : 'You (Capri)'}: ${m.content}`).join('\n');
  return (before ? `Conversation so far:\n${before}\n\nThe user now says:\n` : '') + (last?.content || '');
}

function chat({ model, messages }, onDelta, signal) {
  const system = messages.find((m) => m.role === 'system')?.content || '';
  const args = [
    '-p', '--no-session', '--mode', 'json',
    '-nt', '-ne', '--no-mcp', '-ns', '-np', '--no-themes', '-nc', '-na', '--offline',
    '--thinking', 'off',
    '--model', model || DEFAULT_MODEL,
    '--system-prompt', system,
    prompt(messages),
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(PI, args, {
      cwd: os.tmpdir(),
      stdio: ['ignore', 'pipe', 'pipe'],
      // belt and braces: even if an extension loads, its Capri events go nowhere
      env: { ...process.env, CAPRI_PORT: '1', PI_SUBAGENT_CHILD: '1' },
    });
    let buffer = '';
    let text = '';
    let error = null;
    let stderr = '';
    const timer = setTimeout(() => { error = new Error('pi took too long'); child.kill('SIGTERM'); }, TIMEOUT_MS);
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
        const e = msg.assistantMessageEvent;
        if (msg.type === 'message_update' && e?.type === 'text_delta' && e.delta) {
          text += e.delta;
          onDelta(e.delta);
        } else if (msg.type === 'message_end' && msg.message?.role === 'assistant' && msg.message.stopReason === 'error') {
          error = new Error(msg.message.errorMessage || 'the model failed');
        }
      }
    });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-2000); });
    child.on('error', (err) => { error = err; });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error) return reject(error);
      if (code !== 0 && !text) return reject(new Error(stderr.trim().split('\n').pop() || `pi exited ${code}`));
      resolve(text);
    });
  });
}

module.exports = { chat, DEFAULT_MODEL, PI };
