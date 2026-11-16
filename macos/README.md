# Capri on macOS

The same service as on Linux (`linux/daemon/main.js`) and the same renderer (`src/renderer/`),
with a native overlay app in place of the GTK one. Nothing here is Electron.

```
macos/shell/main.swift   the overlay app: a transparent click-through panel with her renderer in
                         a WKWebView, and the service's window to the system
macos/shell/terminal.html  her terminal's page (xterm.js); its shell runs in main.swift
macos/shell/build.sh     builds macos/shell/Capri.app (needs the Xcode command line tools)
macos/bin/capri-login    start her at login, or stop doing so
macos/daemon/            what replaces the mango, /proc and playerctl modules of linux/daemon/
```

## Run

```sh
npm install --omit=dev --ignore-scripts   # her two fonts and xterm.js; Electron isn't needed
macos/shell/build.sh
linux/bin/capri                           # logs: ~/.local/state/capri/capri.log
linux/bin/capri-ctl show|hide|stow|menu|chat|quit
macos/bin/capri-login install             # start her at login (uninstall | status)
```

**Ctrl+Option+C** puts her away and brings her back. Change it with `"hotkey": "ctrl+alt+c"` in her
config (`""` for none), then restart her.

Settings are in `~/.config/capri/config.json`, as on Linux. `output` is the name of the screen she
lives on (as System Settings shows it); leave it out for the main one.

## Her terminal

Ask her for a terminal in her chat ("open a terminal") and she opens her own: a window in her
colours with your login shell in it, in your home folder. It takes Apple's Terminal's place in the
list of apps she can open; the others (iTerm, Ghostty...) she still opens by name.

- She opens it and that's all. Nothing she or an agent says is ever typed into it.
- Cmd+C copies a selection, Cmd+V pastes, Cmd+A selects all, Cmd+K clears, Cmd+W closes.
- She can sit on it and take it over like any other window. It's also the demo's window, there
  with a few lines of text and no shell behind it.
- The shell is started with nothing of Capri's open but its own terminal (the pipes to the
  service least of all).
- xterm.js is copied into `Capri.app` when it's built: after updating it, run `build.sh` again.

## How it differs from Linux

| | Linux | macOS |
|---|---|---|
| Overlay | GTK4 layer-shell + WebKitGTK | `NSPanel` + `WKWebView`, over the menu bar and full-screen apps |
| Pointer | asked of mango 25 times a second | the system reports each move; passed to the page at most 30 times a second |
| Windows | mango's stream | `CGWindowList`, read when an app comes forward, starts, quits or hides, the space changes, the mouse drags or lets go, and once a second otherwise |
| Battery, network, drives, USB | read from `/sys` and `lsblk` every 4 s | pushed by the system when they change |
| Open and close apps | `.desktop` entries, mango | the Applications folders and `open -a`; closing is what Cmd+Q does |
| Music | playerctl | AppleScript to Spotify (or Music), only if it's already open |
| Her menu | rofi | a native menu, also under her icon in the menu bar |
| Hide and show | a mango bind (Super+C) | a system-wide hot key (Ctrl+Option+C) |
| Start at login | mango's autostart | a LaunchAgent (`macos/bin/capri-login`) |
| The demo's terminal | a `foot` window | her own terminal window, with canned text |
| "Open a terminal" | whichever terminal is installed | her own: xterm.js in a window of the overlay app, your shell on a pty |
| Spotify search secret | gnome-keyring | pi-vault's keychain entry: Touch ID once per run of the service |
| Which window an agent is in | `/proc` | one `ps`, remembered per agent |

The overlay app and the service talk over pipes (see the top of `main.swift`). Vault approvals
work as on Linux: asked over HTTP, answered only by a real click, which reaches the service over
a pipe that only the two of them hold.

## Permissions

- **Controlling Spotify / Music**: macOS asks once, the first time she touches the player.
- Nothing else. Window positions and the pointer need no permission; she never reads window
  titles or the screen.

## Not there yet

- Voice (`linux/tts/`).
