# Capri (Linux and macOS ports): status, decisions, and the other Capri projects

Working notes for this fork. Update when something lands, is decided, or is dropped.
Last updated: 2026-11-19.

- **Repo:** `github.com/minomat180/capri-desktop`, a fork of `mochiiwuff/capri-desktop`.
- **Branch:** `main` holds both ports. New work gets its own `feature/<topic>` branch; local
  text-to-speech is on `feature/voice`, not merged.
- **Run:** Linux: started by mango's autostart. macOS: `macos/README.md`. Both:
  `capri-ctl {show|hide|stow|chat|menu|quit|...}`, logs `~/.local/state/capri/capri.log`, config
  `~/.config/capri/config.json`.
- **Design rule:** the upstream renderer (`src/renderer/`) stays as close to upstream as possible
  so merges keep working. Linux-specific code lives in `linux/`.

## What works now

| Area | State |
|---|---|
| Overlay | GTK4 layer-shell + WebKitGTK, real partial click-through, no focus steal, SUPER+C to stow |
| Grab | hit test on her outline grown 18 px (`GRAB_SCREEN_PX` in `src/renderer/js/capri.js`) |
| Agents | Claude Code (hook, `hooks/capri-hook.js`); subagent/T3 sessions included |
| Activity | one plate per busy agent above her head, max 3 (`TICKER_MAX` in `panel.js`), red on failure |
| Chat | through `claude -p` (`linux/daemon/claude-chat.js`; Haiku by default, `claudeModel` in config), or Ollama (`chatBackend`) |
| Chat while busy | works: agent activity shows as a strip inside the chat, she stays put |
| Apps | open any installed `.desktop` app; close an open one after your click |
| Music | Spotify: skip/back/pause/resume; play a song or playlist by name; "search X" lists hits |
| Spotify search | Web API, dev app `glass-player` (id in config, secret in keyring `SPOTIFY_CLIENT_SECRET`); falls back to a DuckDuckGo site: search |
| Vault approvals | the `/approval` API is still in the service (click-only, via the overlay's private pipe), but no agent tool calls it since the pi extensions were removed on 2026-11-19 (see `vault-approvals.md`) |
| Language | English only (other 4 locales stripped) |

## Decided: wanted / not wanted

The author's call (2026-11-04) on upstream's newer features:

**Wanted** (ported, now on `main`)
- [x] **Pet her** — stroke her mane, she purrs. Ported without the bond system.
- [x] **Reminders** — "remind me in 20 min to…"; she asks when if you didn't say, keeps them across
  restarts, and brings up ones that came due while she was off. Upstream's parser (English).
- [x] **Feels your PC** — own Linux source (`linux/daemon/pc.js`: /proc/stat, /sys/class/power_supply
  across BAT0+BAT1, /sys/class/net, lsblk, /sys/bus/usb, mango for a fullscreen game) polled every
  4 s; renderer `src/renderer/js/pc.js` rewritten for it. Off via config `pcReact`.
- [ ] **Looks at your screen** — needs a Wayland grab (`grim`) and a vision-capable chat path
  (our chat is `claude -p`, text only today). Not started.
- [ ] **Find your files** — Windows-index based upstream; needs a Linux rewrite (`fd`/`plocate`).
  Not started.

**Not wanted**
- `bond.js` — anything that changes with time/relationship. **No evolving personality.** (Verified:
  `pc.js`, `look.js`, `reminders.js`, `files.js` do not reference bond, so they can be taken without it.)
- `custom.js` — "make her yours" (nickname, custom persona lines). Not interesting.
- Codex / Antigravity support — not needed.
- Upstream's LLM layer (`llm.js`, Gemini, Ollama cloud) — we have our own (`claude-chat.js`).
- `system.js` — Windows-only PC control (settings, power, snip). Would be a full rewrite; not asked for.

**On hold / open**
- **Voice (TTS)**: built on `feature/voice` (Linux: Piper, then Kokoro `af_heart`, cached per
  line). Not merged into `main`; not on macOS.
- Upstream merge: not merged. The fork is based on 0.3.1 (`79a016c`); upstream has moved on to 0.5.x. Conflicts expected in
  `lines.js`, `brain.js`, `chat.js` (we changed them a lot: English-only, `{agent}` placeholder).
- **License:** upstream relicensed to PolyForm Noncommercial at 0.4.4. The ported features (pet,
  reminders, feels your PC) come from after that, so the fork as a whole is under PolyForm
  Noncommercial too (`LICENSE`). Art was never under the code's license.
- Hide while a window is fullscreen (capri-mate does it; mango reports fullscreen).
- Waybar module showing her status.
- Guide topics still describe Windows Explorer/tray in places.

## Voice (TTS): researched 2026-11-04 (since built on `feature/voice`)

- **Recommended:** Piper, local, CPU. Now at `OHF-Voice/piper1-gpl` (the old `rhasspy/piper` is
  archived), **GPL-3.0**, `pip install piper-tts`, ~60 MB per voice.
  **Measured on a ThinkPad T480:** ~0.1–0.2 s per line *if the model stays loaded*; a cold CLI call is ~3 s,
  so it must run as one long-lived process, never spawn-per-line.
- **Upgrade if too flat:** Kokoro-82M (`hexgrad/kokoro`, Apache-2.0, ~330 MB, better quality,
  younger-sounding female voices). CPU latency on this machine **unmeasured**.
- **Cloud:** ElevenLabs free tier 10k credits/month (plenty for short lines), best quality, needs an
  account. OpenAI TTS ~$0.015/min.
- **Not worth it:** GPU TTS on the desktop machine: only reachable when the Thunderbolt cable is in, so it needs
  a fallback anyway. Voice cloning of the real VA is off the table (legal/ethical).
- **Integration shape:** daemon keeps a warm TTS process → WAV in `/tmp` → served by the existing
  static server (`.wav` MIME already mapped in `linux/daemon/main.js`) → renderer fetches and plays it
  through `voice.js`'s existing Web Audio `master` gain (reuses mute/volume; avoids WebKitGTK
  autoplay rules). Do **not** add an `<audio>` tag.
- **Still open:** nobody has listened to any candidate voice. Pick one before building.

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

Nobody else has a Wayland port or vault approvals.

## Related files

- `linux/docs/vault-approvals.md` — Capri's approval API for secrets, and what was learned wiring it to T3 Code.
