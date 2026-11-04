// Linux/mango stand-in for src/preload.js: the same `window.host` API, talking to the Capri
// service (linux/daemon/main.js) over HTTP and server-sent events, and to the overlay
// (linux/shell/capri-shell.py) through WebKit's script message handler.
//
// The overlay is click-through except while the pointer is on her (setInteractive), so the page
// only gets real pointer events there. Everywhere else, mango tells the service where the pointer
// is and we replay it as mousemove events, which is what the renderer's hit-testing and her
// "the pointer came close" reactions listen to.
(() => {
  'use strict';

  const token = document.querySelector('meta[name="capri-token"]')?.content || '';
  const shellPost = (msg) => window.webkit?.messageHandlers?.capri?.postMessage(msg);

  // ---------- calls: POST /host/call/<name> ----------
  const call = (name) => async (arg) => {
    const res = await fetch(`/host/call/${name}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-capri-token': token },
      body: JSON.stringify({ arg }),
    });
    const body = await res.json();
    if (!body.ok) throw new Error(body.error || `host call ${name} failed`);
    return body.value;
  };

  // ---------- pushes: one EventSource, fanned out per channel ----------
  const listeners = new Map();
  const on = (channel) => (fn) => {
    if (!listeners.has(channel)) listeners.set(channel, new Set());
    listeners.get(channel).add(fn);
    return () => listeners.get(channel).delete(fn);
  };
  const fire = (channel, payload) => listeners.get(channel)?.forEach((fn) => {
    try { fn(payload); } catch (err) { console.error('[host]', channel, err); }
  });

  const CHANNELS = ['claude:event', 'capri:command', 'capri:config', 'overlay:resize', 'windows:update', 'chat:delta', 'cursor', 'approval:request', 'approval:done', 'approval:result'];
  const stream = new EventSource(`/host/stream?token=${encodeURIComponent(token)}`);
  for (const channel of CHANNELS) {
    stream.addEventListener(channel, (e) => fire(channel, JSON.parse(e.data)));
  }

  // ---------- the pointer ----------
  let lastReal = 0;
  const realMove = () => { lastReal = performance.now(); };
  window.addEventListener('mousemove', (e) => { if (e.isTrusted) realMove(); }, true);
  window.addEventListener('mousedown', realMove, true);
  let pointerOut = false;
  on('cursor')((c) => {
    // the overlay has the real pointer right now: its own events are better than ours
    if (performance.now() - lastReal < 150) return;
    if (!c.inside) {
      if (!pointerOut) document.dispatchEvent(new MouseEvent('mouseleave'));
      pointerOut = true;
      return;
    }
    pointerOut = false;
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: c.x, clientY: c.y, bubbles: true }));
  });

  // ---------- copy image: the overlay snapshots itself ----------
  const pending = new Map();
  let seq = 0;
  window.__capriShellReply = (id, value) => {
    pending.get(id)?.(value);
    pending.delete(id);
  };
  const askShell = (msg, timeout = 5000) => new Promise((resolve) => {
    const id = ++seq;
    pending.set(id, resolve);
    shellPost({ ...msg, id });
    setTimeout(() => { if (pending.delete(id)) resolve(false); }, timeout);
  });

  window.host = {
    onClaudeEvent: on('claude:event'),
    onCommand: on('capri:command'),
    onConfig: on('capri:config'),
    onResize: on('overlay:resize'),
    onWindows: on('windows:update'),
    setInteractive: (interactive) => shellPost({ type: 'interactive', on: Boolean(interactive) }),
    cursor: call('cursor'),
    getConfig: call('getConfig'),
    setConfig: call('setConfig'),
    listSounds: call('listSounds'),
    hooksStatus: call('hooksStatus'),
    demoWindow: (open) => call('demoWindow')(Boolean(open)),
    openMenu: () => { call('openMenu')(); },
    installHooks: call('installHooks'),
    claudeFound: call('claudeFound'),
    openClaudeHelp: () => { call('openClaudeHelp')(); },
    windowsNow: call('windowsNow'),
    trayPlace: call('trayPlace'),
    openClaudeFolder: call('openClaudeFolder'),
    copyImage: (rect) => askShell({ type: 'copy', rect }),
    chatStatus: call('chatStatus'),
    chatSend: call('chatSend'),
    chatStop: (id) => { call('chatStop')(id); },
    onChatDelta: on('chat:delta'),
    openOllama: () => { call('openOllama')(); },
    pcState: call('pcState'),
    openApps: call('openApps'),
    findApp: call('findApp'),
    installedApps: call('installedApps'),
    findInstalled: call('findInstalled'),
    launchApp: call('launchApp'),
    media: call('media'),
    onApproval: on('approval:request'),
    onApprovalDone: on('approval:done'),
    onApprovalResult: on('approval:result'),
    // only a real click counts: the shell drops anything not marked trusted, and it goes over its pipe
    answerApproval: (id, decision, trusted) => shellPost({ type: 'approval', id, decision, trusted: trusted === true }),
    mediaStatus: call('mediaStatus'),
    musicSearch: call('musicSearch'),
    musicPlay: call('musicPlay'),
    musicOpenSearch: call('musicOpenSearch'),
    closeApp: (name, force) => call('closeApp')({ name, force: Boolean(force) }),
    focusOverlay: (focused) => shellPost({ type: 'keyboard', on: Boolean(focused) }),
  };
})();
