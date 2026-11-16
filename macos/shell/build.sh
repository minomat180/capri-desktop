#!/bin/sh
# Build Capri's overlay for macOS: macos/shell/Capri.app (git-ignored). Needs the Xcode command
# line tools (swiftc), and `npm install --omit=dev` done once (her terminal is xterm.js). Signed ad hoc under a fixed identifier, so macOS remembers the permissions
# you give it (controlling Spotify) between builds as well as it can without a developer ID.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
app="$here/Capri.app"
mods="$here/../../node_modules"
[ -f "$mods/@xterm/xterm/lib/xterm.js" ] || { echo "build.sh: run \`npm install --omit=dev\` in $(cd "$here/../.." && pwd) first" >&2; exit 1; }
rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources/terminal"
# her terminal's page, with what it needs next to it
cp "$here/terminal.html" "$app/Contents/Resources/terminal/index.html"
cp "$mods/@xterm/xterm/lib/xterm.js" "$mods/@xterm/xterm/css/xterm.css" "$mods/@xterm/addon-fit/lib/addon-fit.js" "$app/Contents/Resources/terminal/"
for weight in 400 700; do
  cp "$mods/@fontsource/jetbrains-mono/files/jetbrains-mono-latin-$weight-normal.woff2" "$app/Contents/Resources/terminal/jetbrains-mono-$weight.woff2"
done
cat > "$app/Contents/Info.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>ch.mino.capri</string>
  <key>CFBundleName</key><string>Capri</string>
  <key>CFBundleExecutable</key><string>capri-shell</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.3.1</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSAppleEventsUsageDescription</key><string>Capri skips, pauses and plays your music when you ask her to.</string>
  <key>NSAppTransportSecurity</key>
  <dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict>
</plist>
EOF
swiftc -O -o "$app/Contents/MacOS/capri-shell" "$here/main.swift"
codesign --force --sign - --identifier ch.mino.capri "$app" >/dev/null 2>&1
echo "built $app"
