# Capri on macOS

The same service as on Linux (`linux/daemon/main.js`) and the same renderer (`src/renderer/`),
with a native overlay app in place of the GTK one. Nothing here is Electron.

```
macos/shell/main.swift   the overlay app: a transparent click-through panel with her renderer in
                         a WKWebView, and the service's window to the system
macos/shell/build.sh     builds macos/shell/Capri.app (needs the Xcode command line tools)
macos/daemon/            what replaces the mango, /proc and playerctl modules of linux/daemon/
```

## Run

```sh
npm install --omit=dev --ignore-scripts   # her two fonts; Electron isn't needed
macos/shell/build.sh
linux/bin/capri                           # logs: ~/.local/state/capri/capri.log
linux/bin/capri-ctl show|hide|menu|chat|quit
```

Settings are in `~/.config/capri/config.json`, as on Linux. `output` is the name of the screen she
lives on (as System Settings shows it); leave it out for the main one.

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

- The demo's stand-in terminal window (the demo plays without it).
- A global shortcut to hide her (Super+C on Linux): use her menu bar icon or `capri-ctl stow`.
- Starting at login.
- Voice (`linux/tts/`).
