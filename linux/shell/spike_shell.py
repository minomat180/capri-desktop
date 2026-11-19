#!/usr/bin/env python3
"""P0 spike: Capri's renderer in a wlr-layer-shell overlay (GTK4 + WebKitGTK 6).

Not the real shell. It answers one question: can a transparent, click-through
overlay layer host the unchanged renderer on mango, with input limited to the
rectangles the page reports, and the keyboard only on demand?

Run via linux/shell/spike.sh (sets LD_PRELOAD and GI_TYPELIB_PATH).
"""

import functools
import http.server
import json
import os
import sys
import threading

import gi

gi.require_version("Gtk", "4.0")
gi.require_version("Gdk", "4.0")
gi.require_version("Gtk4LayerShell", "1.0")
gi.require_version("WebKit", "6.0")
gi.require_foreign("cairo")
import cairo  # noqa: E402
from gi.repository import Gdk, GLib, Gtk, Gtk4LayerShell as Layer, WebKit  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
PORT = int(os.environ.get("CAPRI_SPIKE_PORT", "47824"))
SHIM = os.path.join(os.path.dirname(__file__), "spike_host_shim.js")


SHELL = None  # the running Shell, for /js


class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args, **kwargs):
        pass

    # test hook: POST /js with JavaScript runs it in the page (spike only, localhost only)
    def do_POST(self):
        if self.path != "/js" or self.headers.get("Origin"):
            self.send_error(403)
            return
        body = self.rfile.read(int(self.headers.get("Content-Length", 0))).decode()
        GLib.idle_add(lambda: SHELL.run_js(body) or False)
        self.send_response(204)
        self.end_headers()


def serve_repo():
    handler = functools.partial(Handler, directory=ROOT)
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()


class Shell(Gtk.Application):
    def __init__(self):
        super().__init__(application_id="dev.mino.capri.spike")
        self.window = None
        self.rects = []

    def do_activate(self):
        win = Gtk.ApplicationWindow(application=self)
        self.window = win
        win.set_decorated(False)

        Layer.init_for_window(win)
        Layer.set_namespace(win, "capri")
        Layer.set_layer(win, Layer.Layer.OVERLAY)
        for edge in (Layer.Edge.TOP, Layer.Edge.BOTTOM, Layer.Edge.LEFT, Layer.Edge.RIGHT):
            Layer.set_anchor(win, edge, True)
        Layer.set_exclusive_zone(win, -1)  # cover the bar too, don't push anything
        Layer.set_keyboard_mode(win, Layer.KeyboardMode.NONE)

        css = Gtk.CssProvider()
        css.load_from_string("window, window * { background: transparent; }")
        Gtk.StyleContext.add_provider_for_display(
            Gdk.Display.get_default(), css, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION
        )

        ucm = WebKit.UserContentManager()
        with open(SHIM, encoding="utf-8") as f:
            ucm.add_script(
                WebKit.UserScript.new(
                    f.read(),
                    WebKit.UserContentInjectedFrames.TOP_FRAME,
                    WebKit.UserScriptInjectionTime.START,
                    None,
                    None,
                )
            )
        ucm.register_script_message_handler("capri", None)
        ucm.connect("script-message-received::capri", self.on_message)

        view = WebKit.WebView(user_content_manager=ucm)
        rgba = Gdk.RGBA()
        rgba.parse("rgba(0,0,0,0)")
        view.set_background_color(rgba)
        settings = view.get_settings()
        settings.set_enable_write_console_messages_to_stdout(True)
        settings.set_enable_webgl(True)
        settings.set_media_playback_requires_user_gesture(False)
        win.set_child(view)
        self.view = view

        win.connect("realize", lambda *_: self.apply_input_region())
        view.load_uri(f"http://127.0.0.1:{PORT}/src/renderer/index.html")
        win.present()
        # nothing clickable until the page says where she is
        GLib.idle_add(self.apply_input_region)

    def on_message(self, _ucm, value):
        try:
            msg = json.loads(value.to_json(0))
        except Exception as err:  # noqa: BLE001
            print("[shell] bad message", err, file=sys.stderr)
            return
        kind = msg.get("type")
        if kind == "rects":
            self.rects = msg.get("rects") or []
            self.apply_input_region()
        elif kind == "keyboard":
            mode = Layer.KeyboardMode.ON_DEMAND if msg.get("on") else Layer.KeyboardMode.NONE
            Layer.set_keyboard_mode(self.window, mode)
            print("[shell] keyboard", "on" if msg.get("on") else "off", flush=True)
        elif kind == "log":
            print("[page]", msg.get("text"), flush=True)

    def run_js(self, source):
        self.view.evaluate_javascript(source, -1, None, None, None, None, None)

    def apply_input_region(self):
        surface = self.window.get_surface() if self.window else None
        if not surface:
            return False
        region = cairo.Region()
        for r in self.rects:
            x, y, w, h = (int(round(r[k])) for k in ("x", "y", "w", "h"))
            if w > 0 and h > 0:
                region.union(cairo.RectangleInt(x, y, w, h))
        surface.set_input_region(region)
        return False


if __name__ == "__main__":
    if not Layer.is_supported():
        sys.exit("layer-shell not supported by this compositor")
    serve_repo()
    SHELL = Shell()
    sys.exit(SHELL.run([]))
