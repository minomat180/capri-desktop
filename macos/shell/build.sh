#!/bin/sh
# Build Capri's overlay for macOS: macos/shell/Capri.app (git-ignored). Needs the Xcode command
# line tools (swiftc). Signed ad hoc under a fixed identifier, so macOS remembers the permissions
# you give it (controlling Spotify) between builds as well as it can without a developer ID.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
app="$here/Capri.app"
rm -rf "$app"
mkdir -p "$app/Contents/MacOS"
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
