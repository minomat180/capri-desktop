# Capri (Linux/mango port) — status, decisions, and the other Capri projects

Working notes for this fork. Update when something lands, is decided, or is dropped.
Last updated: 2026-11-04.

- **Our repo:** `~/Projects/capri-desktop`, private at `github.com/minomat180/capri-desktop`.
  `origin` = ours (push here), `upstream` = `mochiiwuff/capri-desktop` (read-only, push disabled).
- **Branch:** `feature/linux-port` is the working trunk. New work gets its own `feature/<topic>`.
- **Run:** started by mango's autostart; `capri-ctl {show|hide|stow|chat|menu|quit|...}`,
  logs `~/.local/state/capri/capri.log`, config `~/.config/capri/config.json`.
- **Design rule:** the upstream renderer (`src/renderer/`) stays as close to upstream as possible
  so merges keep working. Linux-specific code lives in `linux/`.

## What works now

| Area | State |
|---|---|
| Overlay | GTK4 layer-shell + WebKitGTK, real partial click-through, no focus steal, SUPER+C to stow |
| Grab | hit test on her outline grown 18 px (`GRAB_SCREEN_PX` in `src/renderer/js/capri.js`) |
| Agents | Claude Code (hook) and pi (extension, `linux/pi-extension/`); subagent/T3 sessions included |
| Activity | one plate per busy agent above her head, max 3 (`TICKER_MAX` in `panel.js`), red on failure |
| Chat | through `pi -p` (Claude Haiku by default, `piModel` in config), or Ollama (`chatBackend`) |
| Chat while busy | works: agent activity shows as a strip inside the chat, she stays put |
| Apps | open any installed `.desktop` app; close an open one after your click |
| Music | Spotify: skip/back/pause/resume; play a song or playlist by name; "search X" lists hits |
| Spotify search | Web API, dev app `glass-player` (id in config, secret in keyring `SPOTIFY_CLIENT_SECRET`); falls back to a DuckDuckGo site: search |
| Vault approvals | `ipod_vault_use` / `vault_use` prompts appear on Capri too; click-only, via the overlay's private pipe; answered through T3 when under T3 (see `vault-approvals.md`) |
| Language | English only (other 4 locales stripped) |

## Decided: wanted / not wanted

Mino's call (2026-11-04) on upstream's newer features:

**Wanted**
- `pc.js` — she feels the PC: CPU, battery, charger, network, USB, games. Needs a Linux `host.cpu`.
- `look.js` — looks at the screen and comments. Needs a Wayland grab (`grim`) instead of Windows capture.
- `reminders.js` — "remind me in 20 min to…", kept across restarts. Mostly portable (renderer-side).
- `files.js` — find files / open folders. Windows-index based upstream; needs a Linux rewrite (`fd`/`plocate`).
- Pet her (stroke her mane, she purrs) — renderer-only, should port cleanly.

**Not wanted**
- `bond.js` — anything that changes with time/relationship. **No evolving personality.** (Verified:
  `pc.js`, `look.js`, `reminders.js`, `files.js` do not reference bond, so they can be taken without it.)
- `custom.js` — "make her yours" (nickname, custom persona lines). Not interesting.
- Codex / Antigravity support — not needed.
- Upstream's LLM layer (`llm.js`, Gemini, Ollama cloud) — we have our own (`pi-chat.js`).
- `system.js` — Windows-only PC control (settings, power, snip). Would be a full rewrite; not asked for.

**On hold / open**
- **Voice (TTS)** — researched, nothing built. See "Voice" below. Worth trying on a branch.
- Upstream merge — 67 commits ahead of our base (`79a016c`). Not merged. Conflicts expected in
  `lines.js`, `brain.js`, `chat.js` (we changed them a lot: English-only, `{agent}` placeholder).
- **Upstream relicensed** to PolyForm Noncommercial (was NOASSERTION/MIT-ish for code). Check before
  taking new upstream code if this fork is ever published. Art was never MIT.
- Hide while a window is fullscreen (capri-mate does it; mango reports fullscreen).
- Waybar module showing her status.
- Guide topics still describe Windows Explorer/tray in places.

## Voice (TTS) — built 2026-11-04, on `feature/voice`

**Her voice is Kokoro af_heart** (mino picked it after listening; Piper's voices were rejected as
flat). Off by default: `capri-ctl voice on|off|status|list|prerender|<voice>|say <text>`.

- ~5 s a line on this CPU, so **every line is cached by its text** (`~/.cache/capri/voice/`), and
  her 169 fixed lines are pre-rendered once (`capri-ctl voice prerender`, ~12 min). Cached = 0 ms.
  Only new chat answers wait.
- `linux/tts/tts-server.py` keeps the model warm (load ~5 s), started on her first line, not at boot.
  `linux/daemon/voice.js` owns it; WAVs are served from `/voice/<engine-voice>/<hash>.wav` and played
  through her existing Web Audio gain, so her mute/volume apply.
- Piper is still there as `voiceEngine: 'piper'` (~0.7 s a line, flat).
- Not in git: the venv and models (~650 MB). Setup in `linux/tts/README.md`.
- **Still open:** she speaks panel lines and chat answers; nothing is spoken for the ticker.
  No speech *input* (see `llymemg00/-Capri-voice-`'s `ear.js`).

### Research notes (2026-11-04)

- (Superseded by the above; kept for the numbers.) Piper, local, CPU. Now at `OHF-Voice/piper1-gpl` (the old `rhasspy/piper` is
  archived), **GPL-3.0**, `pip install piper-tts`, ~60 MB per voice.
  **Measured on this T480:** ~0.1–0.2 s per line *if the model stays loaded*; a cold CLI call is ~3 s,
  so it must run as one long-lived process, never spawn-per-line.
- **Upgrade if too flat:** Kokoro-82M (`hexgrad/kokoro`, Apache-2.0, ~330 MB, better quality,
  younger-sounding female voices). CPU latency on this machine **unmeasured**.
- **Cloud:** ElevenLabs free tier 10k credits/month (plenty for short lines), best quality, needs an
  account. OpenAI TTS ~$0.015/min.
- **Not worth it:** GPU TTS on minomat — only reachable when the Thunderbolt cable is in, so it needs
  a fallback anyway. Voice cloning of the real VA is off the table (legal/ethical).
- **Integration shape:** daemon keeps a warm TTS process → WAV in `/tmp` → served by the existing
  static server (`.wav` MIME already mapped in `linux/daemon/main.js`) → renderer fetches and plays it
  through `voice.js`'s existing Web Audio `master` gain (reuses mute/volume; avoids WebKitGTK
  autoplay rules). Do **not** add an `<audio>` tag.
- **VoiceStudio** (`debpalash/VoiceStudio`, AGPL-3.0, 100k★): bundles 17 engines + voice design,
  OpenAI-compatible API on `localhost:3900`. Its good engines (OmniVoice, CosyVoice 3) need
  8 GB+ VRAM = minomat, which is usually unplugged; for CPU it recommends the same small engines
  we already tried. Default weights are CC-BY-NC. Parked, not installed.
- **If better quality is ever wanted:** her fixed set is only 169 lines / ~6.4k characters, so it
  fits ElevenLabs' free monthly tier in one pass, or could be rendered on minomat's GPU and cached
  the same way. Quality then costs nothing at runtime.

## The other Capri projects (surveyed 2026-11-04)

The show's season 2 set off ~30 projects plus 54 forks of upstream in about two weeks. Clones used
for the survey were under `/tmp/capri-cmp` (deleted; re-clone if needed).

| Project | Stack / platform | Worth stealing |
|---|---|---|
| **mochiiwuff/capri-desktop** (353★) — our upstream | Electron, Windows-first | The feature list above. Still very active. **PolyForm Noncommercial** now |
| **lachydotmcg/capri-desktop** (116★) | C#, Windows + VR (Quest) | The best **voice** work: "Hey Capri" wake word, 80 languages, free built-in voice + Piper/Kokoro/Kitten/ElevenLabs/Fish; music mini-player she perches on; chat memory; Discord |
| **TheAgencyMGE/capri-companion** (12★, **MIT, real source**) | Electron/TypeScript, Windows | She drives mouse+keyboard to do tasks, with a refusal list and Esc to stop; push-to-talk |
| **Spectro34/capri-mate** (2★, **MIT**) | Python, GTK4 layer-shell, **Linux** | Technically closest to us. Hides during fullscreen; OpenAI Realtime voice both ways; builds her sprites from the show's frames with SAM 2 instead of redrawn art |
| **Juliowiwiwiwi/Capri-...-Construct** (36★) | Python/PySide6, Windows | Working **Piper + faster-whisper** reference (local TTS and speech-in) |
| **dark-anishi/capri-desktop-noir** (33★) | Electron, Windows, Russian | Drag-and-drop app launcher, game mode, VPN/Zapret controls |
| **chieftaincode** (fork, `arch-linux`) | Electron + KDE/KWin + Python | Another Linux route, KDE-only |
| **barrrliebert** (fork, `feat/linux-support`) | Electron + C/Xlib | X11 only, no use to us |
| **llymemg00/-Capri-voice-** (fork) | — | `ear.js`: hotkey speech-to-text into her chat |
| **ChannelCooperStart/capri-ai** (170★) | — | **AVOID: almost certainly malware.** README only, no source, pushes a `Capri-Setup.exe` and tells you to click past the Windows warning. Star count looks bought |

Nobody else has a Wayland port, pi support, or vault approvals.

## Related files

- `linux/docs/vault-approvals.md` — how pi, T3 Code and Capri connect for secret approvals.
- `~/.pi/agent/AGENTS.md` — machine-wide notes (mango, pi-browser, vaults).
