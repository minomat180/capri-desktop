'use strict';

// Her menu (right-click her, or `capri-ctl menu` -> rofi, on Linux). English only on this build.
const TRAY = {
  en: {
    name: 'English',
    online: (port) => `Capri — listening on ${port}`,
    teleport: 'Teleport', satellite: 'Look at the satellite', demo: 'Play demo', help: 'How does it work?',
    report: 'Mission report', talk: 'Talk to her', chatModel: 'AI model (Ollama)', noOllama: 'Ollama not found',
    show: 'Bring her back', hide: 'Put her away',
    size: 'Size', small: 'Small', medium: 'Medium', large: 'Large', sound: 'Sound', mute: 'Mute',
    soundsDir: 'Open custom sounds folder', screen: 'Screen', wander: 'Wander around when idle',
    possess: 'Possess my windows', lang: 'Language', auto: 'Automatic (system)', startup: 'Start on login',
    hooksOn: 'Claude Code hooks: installed', hooksOff: 'Install Claude Code hooks',
    hooksRemove: 'Remove Claude Code hooks', quit: 'Quit',
  },
};

module.exports = { TRAY, LANGS: Object.keys(TRAY) };
