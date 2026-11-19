#!/bin/sh
# P0 spike launcher. gtk4-layer-shell must be loaded before libwayland-client.
here=$(cd "$(dirname "$0")" && pwd)
export GI_TYPELIB_PATH="$here/typelib${GI_TYPELIB_PATH:+:$GI_TYPELIB_PATH}"
export LD_PRELOAD="/usr/lib/libgtk4-layer-shell.so.0${LD_PRELOAD:+:$LD_PRELOAD}"
unset ELECTRON_RUN_AS_NODE
exec python3 "$here/spike_shell.py" "$@"
