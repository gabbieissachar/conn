#!/bin/bash
# Build Conn.app with the Command Line Tools and SwiftPM. No Xcode.
# usage: ./build.sh          -> build/Conn.app (release)
#        CONN_CONFIG=debug ./build.sh
set -euo pipefail
cd "$(dirname "$0")"
CONFIG=${CONN_CONFIG:-release}
tools/fetch-deps.sh
swift build -c "$CONFIG" --product Conn
swift build -c "$CONFIG" --product FakeHerdr
swift build -c "$CONFIG" --product FakeCampus
APP=build/Conn.app
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/fixture"
cp ".build/$CONFIG/Conn" "$APP/Contents/MacOS/Conn"
cp ".build/$CONFIG/FakeHerdr" build/FakeHerdr
cp ".build/$CONFIG/FakeCampus" build/FakeCampus
cp Resources/fixture/fixture-reader.html Resources/fixture/fixture-lite.html Resources/fixture/fixture-organizer.html Resources/fixture/fixture-stars.json Resources/fixture/fixture-pane-labels.json Resources/fixture/open-asks.json "$APP/Contents/Resources/fixture/"
cp Resources/Conn.icns "$APP/Contents/Resources/Conn.icns"
# The `conn` shell command (README "Opening a folder from the terminal"): File > Install 'conn' Command in PATH links it from ~/.local/bin.
mkdir -p "$APP/Contents/Resources/bin"
cp Resources/bin/conn "$APP/Contents/Resources/bin/conn"
chmod +x "$APP/Contents/Resources/bin/conn"
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>dev.local.conn</string>
  <key>CFBundleName</key><string>Conn</string>
  <key>CFBundleDisplayName</key><string>Conn</string>
  <key>CFBundleExecutable</key><string>Conn</string>
  <key>CFBundleIconFile</key><string>Conn</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>CFBundleDocumentTypes</key><array><dict>
    <key>CFBundleTypeName</key><string>Text</string>
    <key>CFBundleTypeRole</key><string>Editor</string>
    <key>LSItemContentTypes</key><array><string>public.plain-text</string><string>net.daringfireball.markdown</string></array>
  </dict><dict>
    <key>CFBundleTypeName</key><string>Folder</string>
    <key>CFBundleTypeRole</key><string>Viewer</string>
    <key>LSHandlerRank</key><string>None</string>
    <key>LSItemContentTypes</key><array><string>public.folder</string></array>
  </dict></array>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict></plist>
PLIST
echo "built $APP"
