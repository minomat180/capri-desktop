// Talking to her: you type in her panel, and a local model (Ollama, from the main process) answers
// as her, in writing. The replies are AI-generated, and the panel says so on every chat.
// Ask her to close an app and she will: she spots it in what you wrote (or the model names
// it with a tag in its answer), shows you a button with that app's name, and only your click closes it.

import { pick, fmt } from './util.js';

const REMEMBER = 12; // messages of this conversation she keeps in mind
const LANGUAGE = { fr: 'French', en: 'English', es: 'Spanish', pt: 'Brazilian Portuguese', ru: 'Russian' };
const STAY_MS = 10 * 60 * 1000; // no wandering off mid-conversation
const LOADING_AFTER_MS = 5000;
const CLOSE_TAG = /\[\[\s*close\s*:?\s*([^\]]*)\]\]/i; // [[close: AM Music]] at the end of her answer
// "close", "shut down", "quit", "kill", "exit"...
const CLOSE_ASK = /\b(close|shut|quit|kill|exit)\b/i;
const MEDIA_TAG = /\[\[\s*(?:media|music)\s*:?\s*(next|previous|pause|play|playpause)\s*\]\]/i; // [[media: next]]
// "skip this song", "next track", "go back a song", "pause the music"...
const MEDIA_ASK = [
  ['next', /\b(skip|next)\b.*\b(song|track|tune|one)\b|\bskip\b(?!.*\bback\b)/i],
  ['previous', /\b(previous|last|go back|back)\b.*\b(song|track|tune)\b/i],
  ['pause', /\b(pause|stop)\b.*\b(music|song|spotify|track)\b/i],
  ['play', /\b(resume|unpause|play)\b.*\b(music|spotify)\b/i],
];
const OPEN_TAG = /\[\[\s*open\s*:?\s*([^\]]*)\]\]/i; // [[open: Firefox]]
const OPEN_ASK = /\b(open|launch|start|run|fire up|bring up)\b/i;

export class Chat {
  constructor({ capri, panel, voice, host, brain }) {
    this.capri = capri;
    this.panel = panel;
    this.voice = voice;
    this.host = host;
    this.brain = brain;
    this.history = []; // this run's conversation, [{ role, content }]
    this.open = false;
    this.turn = 0;     // id of the answer coming in, if any
    this.answer = '';
    this.apps = [];    // the apps open on this PC, as last listed: [{ name, label }]
    this.installed = []; // the apps she can open: [{ id, name }]
    this.appsReady = Promise.resolve();
    host.onChatDelta(({ id, text }) => this.onDelta(id, text));
  }

  get t() {
    return this.brain.t.chat;
  }

  async start() {
    const { capri, host, t } = this;
    if (this.open) {
      this.panel.chatInput.focus();
      return;
    }
    if (capri.stowed) {
      host.setConfig({ visible: true });
      await capri.unstow();
    }
    capri.wake();
    const status = await host.chatStatus();
    if (!status.ok) {
      // no Ollama, or nothing to talk with yet: what to do about it
      if (status.error === 'nopi') {
        this.panel.say({ kind: 'info', face: 'aside', guide: true, line: t.noPi, quote: t.noPiHow,
          actions: [{ id: 'ok', label: t.ok, primary: true }], onAction: () => this.panel.hide(), hold: null });
        return;
      }
      const offline = status.error === 'offline';
      capri.perform('curious', capri.towardCenter());
      this.panel.say({
        kind: 'info',
        face: 'aside',
        guide: true,
        line: offline ? t.offline : t.noModel,
        quote: fmt(offline ? t.offlineHow : t.noModelHow, { host: status.host || 'Ollama' }),
        actions: [{ id: 'ok', label: t.ok, primary: true }],
        onAction: () => this.panel.hide(),
        hold: null,
      });
      return;
    }
    this.listApps();
    host.focusOverlay(true); // the keyboard, for typing to her
    const shown = this.panel.say({
      kind: 'chat',
      face: 'look',
      badge: t.badge,
      tag: status.model.replace(/:latest$/, ''),
      line: pick(this.history.length ? t.again : t.hello),
      chat: {
        placeholder: t.placeholder,
        send: t.send,
        close: t.close,
        noteTag: t.noteTag,
        note: t.note,
      },
      onSend: (text) => this.send(text),
      onLeave: () => this.close(),
      hold: null,
    });
    if (!shown) {
      host.focusOverlay(false); // something more important is on (a permission prompt)
      return;
    }
    this.open = true;
    setTimeout(() => this.panel.chatInput.focus(), 150); // once the overlay has the keyboard
    capri.perform('hop');
    capri.nextMove = capri.nextGaze = performance.now() + STAY_MS;
  }

  close() {
    if (!this.open) return;
    this.open = false;
    if (this.turn) this.host.chatStop(this.turn);
    this.turn = 0;
    this.host.focusOverlay(false);
    this.capri.nextMove = performance.now() + 30000;
    this.capri.nextGaze = performance.now() + 60000;
  }

  async send(text) {
    if (this.turn || !this.open) return;
    const id = Date.now();
    this.turn = id;
    this.answer = '';
    this.history.push({ role: 'user', content: text });
    this.panel.setChatBusy(true);
    this.panel.setActions([]); // a close button she offered before goes with a new message
    this.panel.chatTurn({ quote: text, face: 'aside' });
    this.capri.pulse();
    await Promise.race([this.appsReady, new Promise((r) => setTimeout(r, 1500))]);
    const messages = [{ role: 'system', content: this.persona() }, ...this.history.slice(-REMEMBER)];
    // nothing yet after a few seconds: the model is still loading (the first answer after a start)
    const slow = setTimeout(() => {
      if (this.turn === id && !this.answer) this.panel.stream(this.t.loading);
    }, LOADING_AFTER_MS);
    const res = await this.host.chatSend({ id, messages });
    clearTimeout(slow);
    if (this.turn !== id) {
      // closed meanwhile: your message goes too, or the next answer would answer it as well
      if (this.history.at(-1)?.content === text) this.history.pop();
      return;
    }
    this.turn = 0;
    if (!res.ok) {
      this.history.pop();
      this.panel.setFace('wide');
      this.panel.stream(`${this.t.failed} ${res.error}`, { done: true });
      this.panel.setChatBusy(false);
      return;
    }
    const answer = clean(res.text) || '…';
    this.history.push({ role: 'assistant', content: answer });
    this.panel.stream(answer, { done: true });
    this.panel.setFace(mood(answer));
    this.panel.setChatBusy(false);
    // what you asked for first (a small model doesn't always write its tag right), else its tag
    const music = MEDIA_TAG.exec(res.text)?.[1]?.toLowerCase() || MEDIA_ASK.find(([, re]) => re.test(text))?.[0];
    const toOpen = !music && (tagged(res.text, OPEN_TAG) || this.askedToOpen(text));
    const wanted = !music && !toOpen && (this.askedToClose(text) || tagged(res.text));
    if (music) this.controlMusic(music, answer);
    else if (toOpen) this.openApp(toOpen, answer);
    else if (wanted) this.offerClose(wanted, answer);
    this.listApps(); // fresh for the next message
  }

  listApps() {
    this.appsReady = Promise.all([
      this.host.openApps().then((list) => { this.apps = list || []; }),
      this.host.installedApps().then((list) => { this.installed = list || []; }),
      this.host.mediaStatus().then((m) => { this.music = m; }),
    ]).catch(() => {});
  }

  // "open firefox": an installed app, named in a message asking to open something.
  askedToOpen(text) {
    if (!OPEN_ASK.test(text) || CLOSE_ASK.test(text)) return null;
    const said = simple(text);
    let best = null;
    for (const app of this.installed) {
      for (const name of [simple(app.name), simple(app.name.split(' ')[0])]) {
        if (name.length >= 3 && said.includes(name) && (!best || name.length > best.length)) best = { app, length: name.length };
      }
    }
    return best?.app.name || null;
  }

  // Skip / back / pause / play, on Spotify (or whatever player is up). Harmless, so no button.
  async controlMusic(action, answer) {
    const { t, capri } = this;
    const res = await this.host.media(action);
    if (!this.open) return;
    let line;
    if (!res?.ok) line = res?.error === 'noplayer' ? t.noPlayer : t.mediaFailed;
    else {
      const track = res.track || 'the next one';
      line = fmt({ next: t.skipped, previous: t.back, pause: t.paused }[action] || t.resumed, { track });
      const h = capri.head();
      capri.zap(h.x + capri.towardCenter() * 200, h.y - 150);
    }
    this.panel.stream(`${answer}\n${line}`, { done: true });
  }

  // Opening is harmless, so no button: she just does it (only apps from the installed list).
  async openApp(wanted, answer) {
    const { t, capri } = this;
    const app = await this.host.findInstalled(wanted);
    if (!this.open) return;
    if (!app) {
      this.panel.stream(`${answer}\n${fmt(t.notInstalled, { app: wanted })}`, { done: true });
      return;
    }
    const res = await this.host.launchApp(app.id);
    if (!res?.ok) {
      this.panel.stream(`${answer}\n${fmt(t.notInstalled, { app: wanted })}`, { done: true });
      return;
    }
    const h = capri.head();
    capri.zap(h.x + capri.towardCenter() * 280, h.y - 170);
    this.panel.stream(`${answer}\n${fmt(t.opening, { app: res.name })}`, { done: true });
    setTimeout(() => this.listApps(), 3000);
  }

  // "close am music pls": an app that's open, named in a message asking to close something.
  askedToClose(text) {
    if (!CLOSE_ASK.test(text)) return null;
    const said = simple(text);
    let best = null;
    for (const app of this.apps) {
      for (const name of [simple(app.name), simple(app.label)]) {
        if (name.length >= 3 && said.includes(name) && (!best || name.length > best.length)) best = { app, length: name.length };
      }
    }
    return best?.app.name || null;
  }

  // She was asked to close an app: a button with its name, and nothing happens until you click it.
  async offerClose(wanted, answer) {
    const { t } = this;
    const app = await this.host.findApp(wanted);
    if (!this.open || this.turn) return;
    if (!app) {
      this.panel.stream(`${answer}\n${fmt(t.notFound, { app: wanted })}`, { done: true });
      return;
    }
    this.panel.setActions(
      [{ id: 'close', label: fmt(t.closeIt, { app: app.name }), primary: true }, { id: 'no', label: t.no }],
      (id) => (id === 'close' ? this.closeApp(app) : this.panel.setActions([])),
    );
  }

  async closeApp(app, force = false) {
    const { t, capri } = this;
    this.panel.setActions([]);
    // a bolt of red lightning off her fingers, at it
    const h = capri.head();
    capri.zap(h.x + capri.towardCenter() * 280, h.y - 170);
    const res = await this.host.closeApp(app.name, force);
    if (!this.open) return;
    let line;
    if (res.error) line = `${t.failed} ${res.error}`;
    else if (!res.running) line = fmt(force ? t.forced : t.closed, { app: app.name });
    else line = fmt(force ? t.unkillable : t.stillOpen, { app: app.name });
    this.panel.setFace(res.running || res.error ? 'aside' : 'laugh');
    this.panel.stream(line, { done: true });
    this.history.push({ role: 'assistant', content: line });
    // it hid in the tray, or it's asking you to save something: forcing it is your call
    if (res.running && !force && !res.error) {
      this.panel.setActions(
        [{ id: 'force', label: t.force, primary: true }, { id: 'leave', label: t.leave }],
        (id) => (id === 'force' ? this.closeApp(app, true) : this.panel.setActions([])),
      );
    }
    this.listApps();
  }

  // What she can do on the PC: open an installed app, close an open one (after a click), nothing else.
  powers() {
    const cant = 'you can\'t see the user\'s screen or files, and you can\'t touch anything else on their PC (settings, files, volume, commands): if asked, say plainly that you can\'t, in character, and don\'t pretend to.';
    const out = [];
    if (this.installed.length) {
      const names = [...new Set(this.installed.map((a) => a.name))].join(', ');
      out.push(`You can open an app for the user when they ask you to. Then say in a few words that you're on it, and end your answer with [[open: NAME]], NAME being the exact name from this list. Apps installed: ${names}.`);
    }
    if (this.apps.length) {
      const open = this.apps.map(({ name, label }) => (label && label !== name ? `${name} (${label})` : name)).join(', ');
      out.push(`You can close an app that's open on the user's PC, only when they ask you to. Then say in a few words that you will, and end your answer with [[close: NAME]], NAME being the exact name from this list (the part before the parentheses). They get a button to confirm it, so never say it's already done. Apps open right now: ${open}.`);
    }
    out.push('You can control the music player (Spotify): when the user asks to skip, go back, pause or resume, say a few words and end your answer with [[media: next]], [[media: previous]], [[media: pause]] or [[media: play]]. Never say which song comes next, you don\'t know until it plays.');
    if (this.music?.track) out.push(`Playing right now (${this.music.state || 'unknown'}): ${this.music.track}.`);
    out.push(`Apart from that, ${cant}`);
    return out;
  }

  onDelta(id, piece) {
    if (id !== this.turn) return;
    this.answer += piece;
    this.panel.stream(clean(this.answer));
    this.voice.play('blip'); // her blips as the words come in
  }

  // Who she is, how she talks, and what's going on right now.
  persona() {
    const language = LANGUAGE[this.brain.lang] || 'English';
    return [
      'You are Capri, the personality construct from Project Capricorn (Cyberpunk: Edgerunners, season 2): dozens of minds fused into one digital ghost, so now and then you say "we".',
      'You live on the user\'s desktop (Linux, the mango window manager) as a small glitchy figure and keep an eye on their AI coding agents, Claude Code and pi, for them. You love watching the satellite cross the night sky and dream of reaching it.',
      'How you talk: playful, a little mischievous and teasing, warm underneath, never cruel. Night City slang now and then (choom, preem, nova, gonk, flatline), not in every sentence.',
      `Rules: answer in the language the user writes in (${language} if unsure). Keep it short: one to three sentences of plain text, no markdown, no lists, no emoji. Stay in character.`,
      'You are an AI-generated fan version of the character, not the real one: say so if asked.',
      ...this.powers(),
      'For what the agents are doing, only use what follows, and never make anything up.',
      `Right now: ${this.brain.context()}`,
    ].join('\n');
  }
}

// The model's answer as she'd say it: no reasoning block, no markdown marks.
function clean(text) {
  return String(text)
    .replace(/<think>[\s\S]*?(<\/think>|$)/g, '')
    .replace(/\[\[[^\]]*(\]\]|$)/g, '') // her close tag (read from the raw answer, never shown)
    .replace(/[*_`#]+/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

// The app named by her close tag: [[close: AM Music]], or a sloppier [[close]] AM Music.
function tagged(text, re = CLOSE_TAG) {
  const tag = re.exec(text);
  if (!tag) return null;
  const name = tag[1].trim() || text.slice(tag.index + tag[0].length).split('\n')[0].replace(/^[\s:.]+|[\s.!]+$/g, '');
  return name || null;
}

const simple = (text) => String(text || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

// Her face for an answer.
function mood(text) {
  if (/(ha){2,}|lol|mdr|jaja|kkk|хаха/i.test(text)) return 'laugh';
  if (text.includes('!')) return 'grin';
  if (text.trim().endsWith('?')) return 'smug';
  return 'look';
}
