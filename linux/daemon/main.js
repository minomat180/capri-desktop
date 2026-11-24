#!/usr/bin/env node
'use strict';

// Capri on Linux/mango, and on macOS: the service. Takes the agent events (Claude Code hooks)
// on 127.0.0.1:47823/event like upstream's Electron app did, serves her renderer,
// gives it the `window.host` API over HTTP + server-sent events, watches mango (windows, focus,
// pointer), and runs the overlay (linux/shell/capri-shell.py) as a child process.
//
// On a Mac the same service runs with macos/daemon/ in place of the mango, /proc and playerctl
// modules, and macos/shell/Capri.app as the overlay (which is also its window to the system).

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');

const MAC = process.platform === 'darwin';
const platform = (name) => require(MAC ? `../../macos/daemon/${name}` : `./${name}`);

const config = require('./config');
const { Desktop } = platform(MAC ? 'desktop' : 'mango');
const native = MAC ? platform('native') : null; // the line to the overlay app, macOS only
const agents = platform('agents');
const apps = platform('apps');
const pc = platform('pc');
const launch = platform('launch');
const media = platform('media');
const music = platform('music');
const claudeChat = require('./claude-chat');
const speech = require('./voice');
const ollama = require('../../src/main/ollama');
const hooks = require('../../scripts/install-hooks');
const demoSteps = require('../../scripts/demo-sequence');
const { TRAY } = require('../../src/main/labels');

const ROOT = path.resolve(__dirname, '..', '..');

// Her art is not in the repository (it belongs to its rights holders): scripts/fetch-art.js gets it.
if (!fs.existsSync(path.join(ROOT, 'assets', 'capri', 'capri-full.png'))) {
  console.error('[capri] her art is missing: run `node scripts/fetch-art.js` first (see README).');
  process.exit(1);
}
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

// ---------- vault approvals ----------
// An agent's secret tool asks here (and may ask in its own dialog too); whichever you answer
// first wins. No tool calls this since the pi vault extensions were removed (vault-approvals.md).
// Requests come over HTTP (anyone local could make one, and that's fine: it only puts a question
// on screen). Answers do NOT: they only come from a real click in the
// overlay, through the shell's private pipe (fd 3) that only this process holds. So an agent can't
// approve its own request with curl.
const approvals = new Map(); // id -> { info, decision, waiters: [res], at }
const APPROVAL_TTL_MS = 10 * 60 * 1000;
const clip = (v, n) => String(v ?? '').slice(0, n);

function approvalRequest(body) {
  const id = crypto.randomBytes(16).toString('hex');
  const info = {
    id,
    vault: clip(body.vault, 40),
    label: clip(body.label, 200),
    reason: clip(body.reason, 500),
    command: clip(body.command, 1000),
    cwd: clip(body.cwd, 300),
    agent: clip(body.agent, 20),
    session: clip(body.session, 120),
  };
  approvals.set(id, { info, decision: null, waiters: [], at: Date.now() });
  log(`approval asked: ${info.vault} "${info.label}" (${id.slice(0, 6)})`);
  emit('approval:request', info);
  return id;
}

function approvalSettle(id, decision, via) {
  const a = approvals.get(id);
  if (!a || a.decision) return;
  a.decision = decision;
  log(`approval ${decision} via ${via}: "${a.info.label}" (${id.slice(0, 6)})`);
  for (const res of a.waiters) send(res, 200, { ok: true, decision });
  a.waiters = [];
  emit('approval:done', { id, decision });
  setTimeout(() => approvals.delete(id), 10 * 60 * 1000); // the command's outcome comes later
}

setInterval(() => {
  for (const [id, a] of approvals) if (!a.decision && Date.now() - a.at > APPROVAL_TTL_MS) approvalSettle(id, 'expired', 'timeout');
}, 30000).unref();

const sendCommand = (name, payload = {}) => emit('capri:command', { name, ...payload });

// ---------- state ----------

const desktop = new Desktop({ ignoreAppIds: ['capri'] });
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
  // her voice off, or a different engine or model: let the loaded one go (macOS: it holds ~16-35 GB)
  if (patch.voice === false || ['voiceEngine', 'voiceModel', 'voiceRef', 'voiceMlxModel'].some((k) => k in patch)) speech.stop();
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
  showStatus();
}

// macOS: her menu bar icon dims while she's put away, and gets a dot while an agent waits on you
let shownStatus = '';
function showStatus(again = false) {
  if (!MAC) return;
  const state = { stowed: !config.load().visible, waiting: status.waiting };
  const key = JSON.stringify(state);
  if (key === shownStatus && !again) return;
  shownStatus = key;
  native.tell('status', state);
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

const openPath = (p) => spawn(MAC ? '/usr/bin/open' : 'xdg-open', [p], { detached: true, stdio: 'ignore' }).unref();

const appInfo = (app) => app && { name: app.process, label: app.name };

let prerendering = false;

// Every fixed thing she can say (src/renderer/js/lines.js), for pre-rendering her voice.
function fixedLines() {
  const out = new Set();
  const walk = (v) => {
    if (typeof v === 'string') { const t = v.trim(); if (t && !t.includes('{') && t.length > 1) out.add(t); }
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  try {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'js', 'lines.js'), 'utf8');
    // the file is an ES module; read it as data rather than importing it into the service
    walk(JSON.parse(JSON.stringify(eval(`(${src.replace(/^export const LINES =/m, '').replace(/;\s*$/, '')})`))));
  } catch (err) {
    log(`could not read her lines: ${err.message}`);
  }
  return [...out];
}

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
  // no Windows tray: point at the right end of waybar, where her module lives. On a Mac she has
  // a real icon in the menu bar (unless the bar is too full to show it).
  trayPlace: async () => {
    const m = desktop.monitor;
    const w = m?.width || 1920;
    // chip: that icon is also where she goes when put away (chip.js), not a mask in the corner
    if (MAC) return { icon: await native.request('tray'), chip: true, corner: { x: w - 260, y: 0, w: 250, h: m?.menuBar || 30 } };
    return { icon: null, corner: { x: w - 260, y: 0, w: 250, h: 30 } };
  },
  demoWindow: (open) => demoWindow(Boolean(open)),
  openMenu: () => openMenu(),
  chatStatus: async () => {
    const cfg = config.load();
    if (cfg.chatBackend !== 'ollama') {
      if (!claudeChat.findClaude()) return { ok: false, error: 'noclaude' };
      return { ok: true, model: String(cfg.claudeModel || claudeChat.DEFAULT_MODEL) };
    }
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
      const cfg = config.load();
      const onDelta = (piece) => emit('chat:delta', { id, text: piece });
      const text = cfg.chatBackend === 'ollama'
        ? await ollama.chat({ model: pickModel(), messages }, onDelta, abort.signal)
        : await claudeChat.chat({ model: cfg.claudeModel || claudeChat.DEFAULT_MODEL, messages }, onDelta, abort.signal);
      return { ok: true, text };
    } catch (err) {
      return { ok: false, error: abort.signal.aborted ? 'stopped' : err.message };
    } finally {
      chats.delete(id);
    }
  },
  chatStop: (id) => chats.get(id)?.abort(),
  openOllama: () => {},
  pcState: () => pc.state(),
  openApps: async () => (await apps.list().catch(() => [])).map(appInfo),
  findApp: async (wanted) => appInfo(await apps.find(wanted).catch(() => null)),
  installedApps: () => launch.installed().map(({ id, name }) => ({ id, name })),
  findInstalled: (wanted) => launch.find(wanted),
  launchApp: (id) => launch.open(id),
  media: (action) => media.control(String(action)),
  mediaStatus: () => media.status(),
  musicSearch: (arg) => (typeof arg === 'object' && arg
    ? music.search(String(arg.query || '').slice(0, 200), arg.kind)
    : music.search(String(arg || '').slice(0, 200))),
  musicPlay: (uri) => music.play(String(uri)),
  musicOpenSearch: (query) => music.openSearch(String(query || '')),
  speak: (arg) => (arg && typeof arg === 'object' ? speech.say(arg.text, { kind: arg.kind }) : speech.say(arg)),
  voiceStatus: () => speech.status(),
  voices: () => speech.voices(),
  setVoice: (id) => { speech.stop(); return updateConfig({ ...speech.pick(id), voice: true }); },
  prerender: () => {
    if (prerendering) return { ok: false, error: 'already running' };
    prerendering = true;
    const lines = fixedLines();
    speech.prerender(lines, (done, total) => emit('voice:prerender', { done, total }))
      .then((r) => log(`prerender: ${r.made} made, ${r.had} already there, ${r.total} lines`))
      .catch((err) => log(`prerender failed: ${err.message}`))
      .finally(() => { prerendering = false; });
    return { ok: true, lines: lines.length };
  },
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
// window rule puts it (app id capri-demo, see README.md, Linux).
let demoTerm = null;
function demoWindow(open) {
  // macOS: the overlay app puts up a window of its own that looks the part
  if (MAC) return native.request('demoWindow', { open }).then(Boolean);
  if (demoTerm) { try { demoTerm.kill(); } catch { /* gone */ } demoTerm = null; }
  if (!open) return false;
  const script = 'printf "\\033[32m~/night-city-api$ npm test -- gigs\\033[0m\\n  GET /gigs\\n'
    + '\\033[32m    ok returns 20 items per page\\n    ok paginates with a cursor\\n    ok rejects a bad cursor\\033[0m\\n'
    + '  6 passing (212ms)\\n\\033[32m~/night-city-api$\\033[0m "; sleep 600';
  demoTerm = spawn('foot', ['--app-id=capri-demo', '--title=night-city-api', 'sh', '-c', script], { stdio: 'ignore' });
  demoTerm.on('exit', () => { demoTerm = null; });
  return true;
}

// ---------- her menu (right-click her, or `capri-ctl menu`): rofi; a native menu on macOS ----------

let menuOpen = false;
async function openMenu() {
  if (menuOpen) return;
  const cfg = config.load();
  const hookState = hooks.status();
  // rofi shows text only, so ticks are drawn; a Mac menu has real ones
  const check = (on, label) => (MAC ? { label, on } : `${on ? '[x]' : '[ ]'} ${label}`);
  const radio = (on, label) => (MAC ? { label: `${t.size}: ${label}`, on } : `${t.size}: ${on ? '(*)' : '( )'} ${label}`);
  const items = [
    [t.teleport, () => sendCommand('teleport')],
    [t.satellite, () => sendCommand('satellite')],
    [t.demo, playDemo],
    [t.help, () => sendCommand('welcome')],
    [t.report, () => sendCommand('report')],
    [t.talk, () => sendCommand('chat')],
    [cfg.visible ? `${t.hide}  (Super+C)` : `${t.show}  (Super+C)`, () => toggleVisible()],
    ...[[t.small, 0.45], [t.medium, 0.6], [t.large, 0.8]].map(([label, scale]) => [
      radio(Math.abs(cfg.scale - scale) < 0.01, label), () => updateConfig({ scale })]),
    [check(cfg.muted, t.mute), () => updateConfig({ muted: !cfg.muted })],
    [check(cfg.wander, t.wander), () => updateConfig({ wander: !cfg.wander })],
    [check(cfg.possess, t.possess), () => updateConfig({ possess: !cfg.possess })],
    [t.soundsDir, () => { fs.mkdirSync(SOUNDS_DIR, { recursive: true }); openPath(SOUNDS_DIR); }],
    hookState.installed ? [t.hooksRemove, () => runHooks('uninstall')] : [t.hooksOff, () => runHooks('install')],
    [t.quit, () => shutdown()],
  ];
  menuOpen = true;
  if (MAC) {
    const keys = hotkey().split('+').map((k) => ({ ctrl: '⌃', control: '⌃', alt: '⌥', option: '⌥', opt: '⌥', cmd: '⌘', command: '⌘', shift: '⇧' })[k] || k.toUpperCase()).join('');
    const shown = items.map(([label]) => (typeof label === 'string' ? { label: label.replace('(Super+C)', keys && `(${keys})`).trim() } : label));
    // open as long as you leave it open
    const i = await native.request('menu', { items: shown }, 10 * 60 * 1000);
    menuOpen = false;
    if (Number.isInteger(i) && items[i]) items[i][1]();
    return;
  }
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

  // agent events: hooks never send an Origin header, browsers always do
  // vault approvals: ask, wait for the answer (long poll), or withdraw (answered in the terminal)
  if (p === '/approval' && req.method === 'POST') {
    if (req.headers.origin) return send(res, 403, { ok: false });
    try {
      const body = await readJson(req, 16 * 1024);
      if (!body?.label) return send(res, 400, { ok: false, error: 'missing label' });
      if (!shell) return send(res, 503, { ok: false, error: 'no overlay' });
      return send(res, 200, { ok: true, id: approvalRequest(body) });
    } catch (err) {
      return send(res, 400, { ok: false, error: err.message });
    }
  }
  // how the command went, after a release (so "released" isn't the last word if it then failed)
  const ar = /^\/approval\/([0-9a-f]{32})\/result$/.exec(p);
  if (ar && req.method === 'POST') {
    if (req.headers.origin) return send(res, 403, { ok: false });
    const a = approvals.get(ar[1]);
    if (!a || a.decision !== 'allow' || a.reported) return send(res, 404, { ok: false });
    a.reported = true;
    try {
      const body = await readJson(req, 4096);
      const exitCode = Number.isInteger(body?.exitCode) ? body.exitCode : null;
      const error = body?.error ? clip(body.error, 200) : null;
      log(`approval outcome: "${a.info.label}" exit ${exitCode}${error ? ` (${error})` : ''}`);
      emit('approval:result', { id: ar[1], label: a.info.label, exitCode, error });
      return send(res, 200, { ok: true });
    } catch (err) {
      return send(res, 400, { ok: false, error: err.message });
    }
  }
  const am = /^\/approval\/([0-9a-f]{32})$/.exec(p);
  if (am) {
    if (req.headers.origin) return send(res, 403, { ok: false });
    const a = approvals.get(am[1]);
    if (!a) return send(res, 404, { ok: false, error: 'unknown' });
    if (req.method === 'DELETE') {
      approvalSettle(am[1], 'withdrawn', 'agent');
      return send(res, 200, { ok: true });
    }
    if (req.method === 'GET') {
      if (a.decision) return send(res, 200, { ok: true, decision: a.decision });
      a.waiters.push(res);
      const t = setTimeout(() => {
        a.waiters = a.waiters.filter((r) => r !== res);
        send(res, 200, { ok: true, decision: null }); // ask again
      }, 50000);
      res.on('close', () => clearTimeout(t));
      return;
    }
  }

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

  // her spoken lines (linux/daemon/voice.js), cached under ~/.cache/capri, not in the repo
  if (req.method === 'GET' && p.startsWith('/voice/')) {
    const [, , dir, name] = p.split('/');
    const file = speech.filePath(dir || '', name || '');
    if (!file) return send(res, 404, { ok: false });
    res.writeHead(200, { 'content-type': 'audio/wav', 'cache-control': 'no-store' });
    return fs.createReadStream(file).pipe(res);
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
  // macOS, where taking a screenshot needs a permission: the overlay photographs its own page
  // (?terminal=1: her newest terminal window instead)
  if (DEV && MAC && req.method === 'POST' && p === '/debug/snapshot') {
    const file = path.join(os.tmpdir(), 'capri', 'snapshot.png');
    return send(res, 200, { ok: Boolean(await native.request('snapshot', { path: file, terminal: url.searchParams.has('terminal') })), file });
  }

  return send(res, 404, { ok: false });
});

// ---------- the pointer: mango tells us where it is, the renderer decides what's her ----------

let lastCursor = '';
let cursorTimer = null;
function pollCursor() {
  if (MAC) return undefined; // the overlay app hears each move from the system and tells the page itself
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

// macOS: the shortcut that puts her away and brings her back (`hotkey` in her config, '' for
// none). On Linux that's a mango bind running `capri-ctl stow`.
const hotkey = () => String(config.load().hotkey ?? 'ctrl+alt+c').toLowerCase().replace(/\s+/g, '');

let shell = null;
let shellRestarts = 0;
let stopping = false;
function startShell() {
  if (NO_SHELL || stopping) return;
  const url = `http://127.0.0.1:${PORT}/app/src/renderer/index.html`;
  if (MAC) {
    const bin = path.join(ROOT, 'macos', 'shell', 'Capri.app', 'Contents', 'MacOS', 'capri-shell');
    if (!fs.existsSync(bin)) { log('the overlay is not built yet: run macos/shell/build.sh'); return; }
    const args = ['--url', url, '--icon', path.join(ROOT, 'assets', 'icons', 'capri.png'), '--hotkey', hotkey()];
    if (desktop.output) args.push('--output', desktop.output);
    // stdin: our requests; fd 3: approval clicks; fd 4: its replies and what it notices
    shell = spawn(bin, args, { stdio: ['pipe', 'inherit', 'inherit', 'pipe', 'pipe'] });
    native.attach(shell);
    showStatus(true);
    watchShell();
    return;
  }
  const here = path.join(ROOT, 'linux', 'shell');
  const env = {
    ...process.env,
    GI_TYPELIB_PATH: [path.join(here, 'typelib'), process.env.GI_TYPELIB_PATH].filter(Boolean).join(':'),
    LD_PRELOAD: [process.env.CAPRI_LAYER_SHELL_LIB || '/usr/lib/libgtk4-layer-shell.so.0', process.env.LD_PRELOAD].filter(Boolean).join(':'),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const args = [path.join(here, 'capri-shell.py'), '--url', url];
  if (desktop.output) args.push('--output', desktop.output);
  shell = spawn('python3', args, { env, stdio: ['ignore', 'inherit', 'inherit', 'pipe'] });
  watchShell();
}

function watchShell() {
  // fd 3: what only a real click in the overlay can send (vault approvals)
  let pending = '';
  shell.stdio[3].on('data', (chunk) => {
    pending += chunk;
    let nl;
    while ((nl = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, nl);
      pending = pending.slice(nl + 1);
      try {
        const msg = JSON.parse(line);
        if (msg.type === 'approval' && typeof msg.id === 'string' && (msg.decision === 'allow' || msg.decision === 'deny')) {
          approvalSettle(msg.id, msg.decision, 'capri');
        }
      } catch { /* not ours */ }
    }
  });
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
  speech.stop(); // let her voice model go with her
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
  // a click on her menu bar icon: her menu, or straight back out if she's put away (right-click: the menu)
  native?.on('menu', (m) => (!config.load().visible && !m.right ? toggleVisible(true) : openMenu()));
  native?.on('hotkey', () => toggleVisible());
  await desktop.start();
  server.on('error', (err) => {
    log(err.code === 'EADDRINUSE' ? `port ${PORT} in use: is Capri already running?` : `server: ${err.message}`);
    process.exit(1);
  });
  server.listen(PORT, '127.0.0.1', () => {
    log(`listening on 127.0.0.1:${PORT}, on output ${desktop.output || 'main'}`);
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
