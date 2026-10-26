#!/usr/bin/env node
'use strict';

// Capri on Linux/mango: the service. Takes the agent events (Claude Code hooks, the pi
// extension) on 127.0.0.1:47823/event like upstream's Electron app did, serves her renderer,
// gives it the `window.host` API over HTTP + server-sent events, watches mango (windows, focus,
// pointer), and runs the overlay (linux/shell/capri-shell.py) as a child process.

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');

const config = require('./config');
const mango = require('./mango');
const agents = require('./agents');
const apps = require('./apps');
const ollama = require('../../src/main/ollama');
const hooks = require('../../scripts/install-hooks');
const demoSteps = require('../../scripts/demo-sequence');
const { TRAY } = require('../../src/main/labels');

const ROOT = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.CAPRI_PORT) || 47823;
const DEV = process.argv.includes('--dev');
const NO_SHELL = process.argv.includes('--no-shell'); // run the overlay yourself (debugging)
const RUNTIME = path.join(process.env.XDG_RUNTIME_DIR || os.tmpdir(), 'capri');
const TOKEN = crypto.randomBytes(24).toString('hex');
const SOUNDS_DIR = path.join(config.DIR, 'sounds');
const SOUND_EXT = /\.(mp3|wav|ogg|m4a)$/i;
const t = TRAY.en;

const log = (...a) => console.log('[capri]', ...a);

// ---------- the token: the renderer and capri-ctl prove they're ours with it ----------

fs.mkdirSync(RUNTIME, { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(RUNTIME, 'token'), TOKEN, { mode: 0o600 });
fs.writeFileSync(path.join(RUNTIME, 'port'), String(PORT), { mode: 0o600 });

// ---------- server-sent events to the renderer (and to `capri-ctl watch`) ----------

const streams = new Set(); // { res, kind: 'renderer' | 'status' }

function emit(channel, payload, kind = 'renderer') {
  const data = `event: ${channel}\ndata: ${JSON.stringify(payload ?? null)}\n\n`;
  for (const s of streams) if (s.kind === kind) s.res.write(data);
}

const sendCommand = (name, payload = {}) => emit('capri:command', { name, ...payload });

// ---------- state ----------

const desktop = new mango.Desktop({ ignoreAppIds: ['capri'] });
let lastWindows = null;
let chatModels = null;
const chats = new Map();
const status = { working: false, agent: null, project: null, action: null, waiting: false, visible: true };

function rendererConfig() {
  return { ...config.load(), lang: 'en', langSetting: 'en' };
}

function updateConfig(patch) {
  config.save(patch);
  const cfg = rendererConfig();
  emit('capri:config', cfg);
  if ('visible' in patch) publishStatus({ visible: cfg.visible });
  return cfg;
}

function toggleVisible(force) {
  const visible = typeof force === 'boolean' ? force : !config.load().visible;
  updateConfig({ visible });
  sendCommand('stow', { on: !visible });
}

function publishStatus(patch) {
  Object.assign(status, patch);
  emit('status', status, 'status');
}

// ---------- agent events in ----------

const BUSY = new Set(['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'SubagentStart', 'SubagentStop', 'PreCompact']);

function onAgentEvent(evt) {
  // which window it runs in, from its process tree (the hook / extension sends its agent's pid)
  if (evt.agent_pid && !evt.window_id) evt.window_id = agents.windowFor(Number(evt.agent_pid), desktop);
  emit('claude:event', evt);
  const name = evt.hook_event_name;
  if (name === 'Notification') publishStatus({ waiting: true });
  else if (name === 'Stop' || name === 'StopFailure' || name === 'SessionEnd') publishStatus({ working: false, waiting: false, action: null });
  else if (BUSY.has(name)) {
    publishStatus({
      working: true,
      waiting: false,
      agent: evt.agent || 'claude',
      project: evt.cwd ? path.basename(evt.cwd) : status.project,
      action: evt.tool_name || status.action,
    });
  }
}

let demoTimer = null;
function playDemo() {
  clearTimeout(demoTimer);
  let i = 0;
  const next = () => {
    if (i >= demoSteps.length) return;
    const [delay, evt] = demoSteps[i++];
    demoTimer = setTimeout(() => { emit('claude:event', evt); next(); }, delay);
  };
  next();
}

// ---------- the host API (src/preload.js, over HTTP) ----------

function listSounds() {
  try {
    return fs.readdirSync(SOUNDS_DIR).filter((f) => SOUND_EXT.test(f))
      .map((f) => ({ name: f.replace(SOUND_EXT, '').toLowerCase(), url: `/usersounds/${encodeURIComponent(f)}` }));
  } catch {
    return [];
  }
}

function pickModel(cfg = config.load()) {
  if (!chatModels?.length) return null;
  return chatModels.includes(cfg.chatModel) ? cfg.chatModel : chatModels[0];
}

async function refreshModels() {
  process.env.OLLAMA_HOST = config.load().ollamaHost || process.env.OLLAMA_HOST || '127.0.0.1:11434';
  chatModels = await ollama.models().catch(() => null);
  return chatModels;
}

const openPath = (p) => spawn('xdg-open', [p], { detached: true, stdio: 'ignore' }).unref();

const appInfo = (app) => app && { name: app.process, label: app.name };

const HOST = {
  getConfig: () => rendererConfig(),
  setConfig: (patch) => updateConfig(patch || {}),
  listSounds,
  hooksStatus: () => hooks.status(),
  installHooks: () => runHooks('install', { quiet: true }),
  claudeFound: () => fs.existsSync(path.dirname(hooks.status().file)),
  openClaudeHelp: () => openPath('https://code.claude.com/docs/en/quickstart'),
  openClaudeFolder: () => {
    const dir = path.dirname(hooks.status().file);
    if (!fs.existsSync(dir)) return { found: false, dir };
    openPath(dir);
    return { found: true, dir, file: fs.existsSync(hooks.status().file) };
  },
  windowsNow: () => lastWindows,
  cursor: async () => (await desktop.cursor().catch(() => null)) || { x: 0, y: 0, inside: false },
  // no Windows tray: point at the right end of waybar, where her module lives
  trayPlace: () => {
    const m = desktop.monitor;
    const w = m?.width || 1920;
    return { icon: null, corner: { x: w - 260, y: 0, w: 250, h: 30 } };
  },
  demoWindow: (open) => demoWindow(Boolean(open)),
  openMenu: () => openMenu(),
  chatStatus: async () => {
    const models = await refreshModels();
    const host = process.env.OLLAMA_HOST;
    if (!models) return { ok: false, error: 'offline', host };
    if (!models.length) return { ok: false, error: 'nomodel', host };
    ollama.warm(pickModel());
    return { ok: true, model: pickModel() };
  },
  chatSend: async ({ id, messages }) => {
    const abort = new AbortController();
    chats.set(id, abort);
    try {
      const text = await ollama.chat({ model: pickModel(), messages }, (piece) => emit('chat:delta', { id, text: piece }), abort.signal);
      return { ok: true, text };
    } catch (err) {
      return { ok: false, error: abort.signal.aborted ? 'stopped' : err.message };
    } finally {
      chats.delete(id);
    }
  },
  chatStop: (id) => chats.get(id)?.abort(),
  openOllama: () => {},
  openApps: async () => (await apps.list().catch(() => [])).map(appInfo),
  findApp: async (wanted) => appInfo(await apps.find(wanted).catch(() => null)),
  closeApp: ({ name, force }) => apps.close(name, { force: Boolean(force) }).catch((err) => ({ error: err.message })),
};

function runHooks(action, { quiet = false } = {}) {
  let outcome;
  try {
    const result = action === 'install' ? hooks.install() : hooks.uninstall();
    outcome = { action, ok: true, file: result.file };
  } catch (err) {
    outcome = { action, ok: false, error: err.message };
  }
  if (!quiet) sendCommand('hooks', outcome);
  return outcome;
}

// During the demo: a little terminal for her to sit on and take over. Floats where a mango
// window rule puts it (app id capri-demo, see linux/README.md).
let demoTerm = null;
function demoWindow(open) {
  if (demoTerm) { try { demoTerm.kill(); } catch { /* gone */ } demoTerm = null; }
  if (!open) return false;
  const script = 'printf "\\033[32m~/night-city-api$ npm test -- gigs\\033[0m\\n  GET /gigs\\n'
    + '\\033[32m    ok returns 20 items per page\\n    ok paginates with a cursor\\n    ok rejects a bad cursor\\033[0m\\n'
    + '  6 passing (212ms)\\n\\033[32m~/night-city-api$\\033[0m "; sleep 600';
  demoTerm = spawn('foot', ['--app-id=capri-demo', '--title=night-city-api', 'sh', '-c', script], { stdio: 'ignore' });
  demoTerm.on('exit', () => { demoTerm = null; });
  return true;
}

// ---------- her menu (right-click her, or `capri-ctl menu`): rofi ----------

let menuOpen = false;
function openMenu() {
  if (menuOpen) return;
  const cfg = config.load();
  const hookState = hooks.status();
  const check = (on, label) => `${on ? '[x]' : '[ ]'} ${label}`;
  const items = [
    [t.teleport, () => sendCommand('teleport')],
    [t.satellite, () => sendCommand('satellite')],
    [t.demo, playDemo],
    [t.help, () => sendCommand('welcome')],
    [t.report, () => sendCommand('report')],
    [t.talk, () => sendCommand('chat')],
    [cfg.visible ? `${t.hide}  (Super+C)` : `${t.show}  (Super+C)`, () => toggleVisible()],
    ...[[t.small, 0.45], [t.medium, 0.6], [t.large, 0.8]].map(([label, scale]) => [
      `${t.size}: ${Math.abs(cfg.scale - scale) < 0.01 ? '(*)' : '( )'} ${label}`, () => updateConfig({ scale })]),
    [check(cfg.muted, t.mute), () => updateConfig({ muted: !cfg.muted })],
    [check(cfg.wander, t.wander), () => updateConfig({ wander: !cfg.wander })],
    [check(cfg.possess, t.possess), () => updateConfig({ possess: !cfg.possess })],
    [t.soundsDir, () => { fs.mkdirSync(SOUNDS_DIR, { recursive: true }); openPath(SOUNDS_DIR); }],
    hookState.installed ? [t.hooksRemove, () => runHooks('uninstall')] : [t.hooksOff, () => runHooks('install')],
    [t.quit, () => shutdown()],
  ];
  menuOpen = true;
  const child = execFile('rofi', ['-dmenu', '-i', '-p', 'Capri', '-format', 'i', '-no-custom'], { timeout: 120000 }, (err, out) => {
    menuOpen = false;
    const i = Number(String(out).trim());
    if (!err && Number.isInteger(i) && items[i]) items[i][1]();
  });
  child.stdin.end(items.map(([label]) => label).join('\n'));
}

// ---------- HTTP ----------

function send(res, status, body, type = 'application/json') {
  const data = type === 'application/json' ? JSON.stringify(body) : body;
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(data);
}

function readJson(req, max = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > max) { reject(new Error('payload too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      try { resolve(text ? JSON.parse(text) : {}); } catch { reject(new Error('invalid json')); }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2', '.json': 'application/json',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.ico': 'image/x-icon',
};
// what the renderer may load: its own files, the art, the fonts, the Linux host shim
const SERVED = ['src/renderer/', 'assets/', 'node_modules/@fontsource/', 'linux/renderer/'];

function serveFile(res, rel, base = ROOT, allowed = SERVED) {
  const file = path.resolve(base, '.' + path.sep + rel);
  const inside = file.startsWith(base + path.sep) && allowed.some((p) => file.startsWith(path.join(base, p)));
  if (!inside || !fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, { ok: false });
  let body = fs.readFileSync(file);
  if (rel === 'src/renderer/index.html') {
    // the Linux host (window.host over HTTP) goes in before the app, with the token
    body = String(body).replace('<link rel="stylesheet"',
      `<meta name="capri-token" content="${TOKEN}">\n  <script src="../../linux/renderer/host-linux.js"></script>\n  <link rel="stylesheet"`);
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(body);
}

const authed = (req, url) => req.headers['x-capri-token'] === TOKEN || url.searchParams.get('token') === TOKEN;

const CTL = {
  stow: () => toggleVisible(),
  show: () => toggleVisible(true),
  hide: () => toggleVisible(false),
  menu: () => openMenu(),
  status: () => sendCommand('status'),
  teleport: () => sendCommand('teleport'),
  satellite: () => sendCommand('satellite'),
  demo: () => playDemo(),
  report: () => sendCommand('report'),
  chat: () => sendCommand('chat'),
  quit: () => shutdown(),
};

const server = http.createServer(async (req, res) => {
  // DNS rebinding: only our own name. Cross-site browser requests carry an Origin header and no
  // token, so they get nowhere either.
  const host = req.headers.host || '';
  if (host !== `127.0.0.1:${PORT}` && host !== `localhost:${PORT}`) return send(res, 403, { ok: false });
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = url.pathname;

  if (req.method === 'GET' && p === '/health') return send(res, 200, { ok: true, name: 'capri', pid: process.pid });

  // agent events: hooks and the pi extension never send an Origin header, browsers always do
  if (req.method === 'POST' && p === '/event') {
    if (req.headers.origin) return send(res, 403, { ok: false });
    try {
      const evt = await readJson(req, 512 * 1024);
      if (!evt || typeof evt.hook_event_name !== 'string') return send(res, 400, { ok: false, error: 'missing hook_event_name' });
      onAgentEvent(evt);
      return send(res, 200, { ok: true });
    } catch (err) {
      return send(res, 400, { ok: false, error: err.message });
    }
  }

  if (req.method === 'GET' && p.startsWith('/app/')) return serveFile(res, decodeURIComponent(p.slice(5)));
  if (req.method === 'GET' && p.startsWith('/usersounds/')) {
    return serveFile(res, decodeURIComponent(p.slice(12)), SOUNDS_DIR, ['']);
  }

  if (!authed(req, url)) return send(res, 403, { ok: false });

  if (req.method === 'GET' && (p === '/host/stream' || p === '/status/stream')) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write(': hello\n\n');
    const s = { res, kind: p === '/host/stream' ? 'renderer' : 'status' };
    streams.add(s);
    if (s.kind === 'status') res.write(`event: status\ndata: ${JSON.stringify(status)}\n\n`);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => { clearInterval(ping); streams.delete(s); });
    return undefined;
  }

  if (req.method === 'POST' && p.startsWith('/host/call/')) {
    const fn = HOST[p.slice(11)];
    if (!fn) return send(res, 404, { ok: false });
    try {
      const { arg } = await readJson(req);
      return send(res, 200, { ok: true, value: (await fn(arg)) ?? null });
    } catch (err) {
      return send(res, 500, { ok: false, error: err.message });
    }
  }

  if (req.method === 'POST' && p.startsWith('/ctl/')) {
    const fn = CTL[p.slice(5)];
    if (!fn) return send(res, 404, { ok: false, error: `unknown command, try: ${Object.keys(CTL).join(' ')}` });
    await fn();
    return send(res, 200, { ok: true });
  }

  if (DEV && req.method === 'POST' && p === '/debug/command') {
    const body = await readJson(req).catch(() => ({}));
    sendCommand(body.name, body);
    return send(res, 200, { ok: true });
  }

  return send(res, 404, { ok: false });
});

// ---------- the pointer: mango tells us where it is, the renderer decides what's her ----------

let lastCursor = '';
let cursorTimer = null;
function pollCursor() {
  const hasRenderer = [...streams].some((s) => s.kind === 'renderer');
  const next = () => { cursorTimer = setTimeout(pollCursor, 40); };
  if (!hasRenderer) return next();
  desktop.cursor().then((c) => {
    if (!c) return;
    const key = `${Math.round(c.x)},${Math.round(c.y)},${c.inside}`;
    if (key === lastCursor) return;
    lastCursor = key;
    emit('cursor', { x: c.x, y: c.y, inside: c.inside });
  }).catch(() => {}).finally(next);
  return undefined;
}

// ---------- the overlay ----------

let shell = null;
let shellRestarts = 0;
let stopping = false;
function startShell() {
  if (NO_SHELL || stopping) return;
  const here = path.join(ROOT, 'linux', 'shell');
  const env = {
    ...process.env,
    GI_TYPELIB_PATH: [path.join(here, 'typelib'), process.env.GI_TYPELIB_PATH].filter(Boolean).join(':'),
    LD_PRELOAD: ['/usr/lib/libgtk4-layer-shell.so.0', process.env.LD_PRELOAD].filter(Boolean).join(':'),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const url = `http://127.0.0.1:${PORT}/app/src/renderer/index.html`;
  const args = [path.join(here, 'capri-shell.py'), '--url', url];
  if (desktop.output) args.push('--output', desktop.output);
  shell = spawn('python3', args, { env, stdio: ['ignore', 'inherit', 'inherit'] });
  const started = Date.now();
  shell.on('exit', (code, signal) => {
    shell = null;
    if (stopping) return;
    log(`overlay exited (${signal || code})`);
    if (Date.now() - started > 60000) shellRestarts = 0;
    if (shellRestarts++ < 5) setTimeout(startShell, 1000 * shellRestarts);
    else log('overlay keeps dying, giving up; restart capri');
  });
}

function shutdown() {
  stopping = true;
  clearTimeout(cursorTimer);
  desktop.stop();
  demoWindow(false);
  if (shell) shell.kill('SIGTERM');
  for (const s of streams) s.res.end();
  server.close();
  try { fs.unlinkSync(path.join(RUNTIME, 'token')); } catch { /* fine */ }
  setTimeout(() => process.exit(0), 300);
}

// ---------- go ----------

async function main() {
  const cfg = config.load();
  if (cfg.output) desktop.output = cfg.output;
  desktop.on('windows', (snap) => {
    lastWindows = snap;
    emit('windows:update', snap);
  });
  desktop.on('error', (err) => log('mango ipc:', err.message));
  await desktop.start();
  server.on('error', (err) => {
    log(err.code === 'EADDRINUSE' ? `port ${PORT} in use: is Capri already running?` : `server: ${err.message}`);
    process.exit(1);
  });
  server.listen(PORT, '127.0.0.1', () => {
    log(`listening on 127.0.0.1:${PORT}, on output ${desktop.output}`);
    startShell();
    pollCursor();
    refreshModels();
  });
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('[capri] failed to start:', err.message);
  process.exit(1);
});
