// P0 spike: a stand-in for Electron's preload (src/preload.js). Same `window.host` surface,
// fake data, and it tells the shell which rectangles should catch the pointer.
(() => {
  const post = (msg) => window.webkit?.messageHandlers?.capri?.postMessage(msg);
  const listeners = {};
  const on = (channel) => (fn) => {
    (listeners[channel] ||= new Set()).add(fn);
    return () => listeners[channel].delete(fn);
  };
  // the shell (or a test) pushes events in through here
  window.__capriEmit = (channel, payload) => listeners[channel]?.forEach((fn) => fn(payload));

  const config = {
    scale: 0.6, muted: false, volume: 0.7, lang: 'en', langSetting: 'en', displayId: null,
    wander: true, possess: true, visible: true, welcomed: true, linked: true, chatModel: null,
  };

  window.host = {
    onClaudeEvent: on('claude:event'),
    onCommand: on('capri:command'),
    onConfig: on('capri:config'),
    onResize: on('overlay:resize'),
    onWindows: on('windows:update'),
    setInteractive: () => {}, // the shell uses the reported rectangles instead
    cursor: async () => ({ x: 0, y: 0, inside: false }),
    getConfig: async () => ({ ...config }),
    setConfig: async (patch) => Object.assign(config, patch),
    listSounds: async () => [],
    hooksStatus: async () => ({ installed: true, events: [] }),
    demoWindow: async () => false,
    openMenu: () => post({ type: 'log', text: 'menu requested' }),
    installHooks: async () => ({ ok: true }),
    claudeFound: async () => true,
    openClaudeHelp: () => {},
    windowsNow: async () => null,
    trayPlace: async () => ({ icon: null, corner: { x: innerWidth - 150, y: 0, w: 140, h: 30 } }),
    openClaudeFolder: async () => ({ found: false }),
    copyImage: async () => false,
    chatStatus: async () => ({ ok: false, error: 'offline' }),
    chatSend: async () => ({ ok: false, error: 'offline' }),
    chatStop: () => {},
    onChatDelta: on('chat:delta'),
    openOllama: () => {},
    openApps: async () => [],
    findApp: async () => null,
    closeApp: async () => ({ running: true }),
    focusOverlay: (focused) => post({ type: 'keyboard', on: Boolean(focused) }),
  };

  // where she is, her panel and her chip: the only places that should catch the pointer
  let last = '';
  const box = (el) => {
    if (!el || el.hidden || el.closest('[hidden]')) return null;
    const r = el.getBoundingClientRect();
    return r.width && r.height ? { x: r.left, y: r.top, w: r.width, h: r.height } : null;
  };
  const report = () => {
    const rects = ['sprite', 'panel', 'chip', 'mask'].map((id) => box(document.getElementById(id))).filter(Boolean);
    const key = JSON.stringify(rects.map((r) => [r.x, r.y, r.w, r.h].map(Math.round)));
    if (key !== last) {
      last = key;
      post({ type: 'rects', rects });
    }
  };
  setInterval(report, 50);
})();
