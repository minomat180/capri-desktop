#!/usr/bin/env python3
"""Capri's overlay on Wayland: a wlr-layer-shell surface on the overlay layer, transparent,
holding her renderer in WebKitGTK. Started (and restarted) by linux/daemon/main.js.

What it does for the page (window.webkit.messageHandlers.capri):
  {type: 'interactive', on}  -> catch the pointer (whole surface) or let it all through
  {type: 'keyboard', on}     -> take the keyboard while her chat is open, give it back after
  {type: 'copy', id, rect}   -> PNG of that part of the overlay onto the clipboard (wl-copy)

Needs gtk4-layer-shell loaded before libwayland-client (LD_PRELOAD) and its typelib
(GI_TYPELIB_PATH); the service sets both.
"""

import argparse
import json
import os
import signal
import subprocess
import sys

import gi

gi.require_version("Gtk", "4.0")
gi.require_version("Gdk", "4.0")
gi.require_version("Gtk4LayerShell", "1.0")
gi.require_version("WebKit", "6.0")
gi.require_foreign("cairo")
import cairo  # noqa: E402
from gi.repository import Gdk, GLib, Gtk, Gtk4LayerShell as Layer, WebKit  # noqa: E402

DATA = os.path.join(os.environ.get("XDG_DATA_HOME", os.path.expanduser("~/.local/share")), "capri", "webkit")
CACHE = os.path.join(os.environ.get("XDG_CACHE_HOME", os.path.expanduser("~/.cache")), "capri", "webkit")


def log(*args):
    print("[capri-shell]", *args, flush=True)


class Shell(Gtk.Application):
    def __init__(self, url, output):
        super().__init__(application_id="dev.mino.capri")
        self.url = url
        self.output = output
        self.window = None
        self.view = None
        self.interactive = False

    # ---------- window ----------

    def do_activate(self):
        win = Gtk.ApplicationWindow(application=self)
        self.window = win
        win.set_decorated(False)
        win.set_title("Capri")

        Layer.init_for_window(win)
        Layer.set_namespace(win, "capri")
        Layer.set_layer(win, Layer.Layer.OVERLAY)
        for edge in (Layer.Edge.TOP, Layer.Edge.BOTTOM, Layer.Edge.LEFT, Layer.Edge.RIGHT):
            Layer.set_anchor(win, edge, True)
        Layer.set_exclusive_zone(win, -1)  # over the bar too, and push nothing around
        Layer.set_keyboard_mode(win, Layer.KeyboardMode.NONE)
        monitor = self.find_monitor(self.output)
        if monitor:
            Layer.set_monitor(win, monitor)

        css = Gtk.CssProvider()
        css.load_from_string("window, window * { background: transparent; }")
        Gtk.StyleContext.add_provider_for_display(
            Gdk.Display.get_default(), css, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION
        )

        ucm = WebKit.UserContentManager()
        ucm.register_script_message_handler("capri", None)
        ucm.connect("script-message-received::capri", self.on_message)

        os.makedirs(DATA, exist_ok=True)
        os.makedirs(CACHE, exist_ok=True)
        session = WebKit.NetworkSession.new(DATA, CACHE)  # localStorage survives (her mission log)
        view = WebKit.WebView(user_content_manager=ucm, network_session=session)
        transparent = Gdk.RGBA()
        transparent.parse("rgba(0,0,0,0)")
        view.set_background_color(transparent)
        settings = view.get_settings()
        settings.set_enable_write_console_messages_to_stdout(True)
        settings.set_enable_webgl(True)
        settings.set_media_playback_requires_user_gesture(False)
        settings.set_enable_back_forward_navigation_gestures(False)
        view.connect("context-menu", lambda *_: True)  # her own right-click handling only
        view.connect("web-process-terminated", self.on_crash)
        win.set_child(view)
        self.view = view

        win.connect("realize", lambda *_: self.apply_input_region())
        win.connect("notify::default-width", lambda *_: self.apply_input_region())
        win.connect("notify::default-height", lambda *_: self.apply_input_region())
        view.load_uri(self.url)
        win.present()
        GLib.idle_add(self.apply_input_region)

    @staticmethod
    def find_monitor(name):
        if not name:
            return None
        monitors = Gdk.Display.get_default().get_monitors()
        for i in range(monitors.get_n_items()):
            m = monitors.get_item(i)
            if m.get_connector() == name:
                return m
        return None

    def on_crash(self, _view, reason):
        log("web process died:", reason)
        self.quit()  # the service restarts us

    # ---------- the page's requests ----------

    def on_message(self, _ucm, value):
        try:
            msg = json.loads(value.to_json(0))
        except Exception as err:  # noqa: BLE001
            log("bad message:", err)
            return
        kind = msg.get("type")
        if kind == "interactive":
            self.interactive = bool(msg.get("on"))
            self.apply_input_region()
        elif kind == "keyboard":
            on = bool(msg.get("on"))
            Layer.set_keyboard_mode(self.window, Layer.KeyboardMode.EXCLUSIVE if on else Layer.KeyboardMode.NONE)
        elif kind == "copy":
            self.copy(msg.get("id"), msg.get("rect") or {})
        elif kind == "approval":
            # a vault approval, clicked in her panel: straight to the service over fd 3 (a pipe
            # only it holds; never over HTTP, where an agent could fake it)
            decision = msg.get("decision")
            if msg.get("trusted") is True and decision in ("allow", "deny") and isinstance(msg.get("id"), str):
                try:
                    os.write(3, (json.dumps({"type": "approval", "id": msg["id"], "decision": decision}) + "\n").encode())
                except OSError as err:
                    log("approval pipe:", err)

    def apply_input_region(self):
        surface = self.window.get_surface() if self.window else None
        if not surface:
            return False
        if self.interactive:
            surface.set_input_region(None)  # the whole overlay catches the pointer
        else:
            surface.set_input_region(cairo.Region())  # nothing does: it all goes through
        return False

    def reply(self, msg_id, value):
        self.view.evaluate_javascript(
            f"window.__capriShellReply && window.__capriShellReply({json.dumps(msg_id)}, {json.dumps(value)})",
            -1, None, None, None, None, None,
        )

    def copy(self, msg_id, rect):
        def done(view, result):
            try:
                texture = view.get_snapshot_finish(result)
                png = texture.save_to_png_bytes().get_data()
                from gi.repository import GdkPixbuf  # noqa: PLC0415
                loader = GdkPixbuf.PixbufLoader.new_with_type("png")
                loader.write(png)
                loader.close()
                full = loader.get_pixbuf()
                scale = full.get_width() / max(1, self.view.get_width())
                x, y = int(rect.get("x", 0) * scale), int(rect.get("y", 0) * scale)
                w, h = int(rect.get("width", full.get_width()) * scale), int(rect.get("height", full.get_height()) * scale)
                x, y = max(0, x), max(0, y)
                w, h = min(w, full.get_width() - x), min(h, full.get_height() - y)
                ok, data = full.new_subpixbuf(x, y, w, h).save_to_bufferv("png", [], [])
                subprocess.run(["wl-copy", "--type", "image/png"], input=data, check=True, timeout=5)
                self.reply(msg_id, True)
            except Exception as err:  # noqa: BLE001
                log("copy failed:", err)
                self.reply(msg_id, False)

        self.view.get_snapshot(WebKit.SnapshotRegion.VISIBLE, WebKit.SnapshotOptions.TRANSPARENT_BACKGROUND, None, done)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", required=True)
    parser.add_argument("--output", default=None)
    args = parser.parse_args()
    if not Layer.is_supported():
        sys.exit("capri-shell: this compositor has no wlr-layer-shell")
    app = Shell(args.url, args.output)
    GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, signal.SIGTERM, lambda: app.quit() or False)
    sys.exit(app.run([]))


if __name__ == "__main__":
    main()
