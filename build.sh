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
# Every file in the bundle is installed as a new file plus a rename, never written over in place.
# macOS caches a code signature per inode, so overwriting the executable of a bundle that was
# built (and signed) before leaves the old signature on the new bytes: the next launch is killed
# at dyld with "Code Signature Invalid" and `codesign --verify` fails. A rename gives the path a
# fresh inode, and a running Conn keeps its old inode until it quits.
# usage: install_file SOURCE DEST MODE
install_file() {
  local src=$1 dest=$2 mode=$3 tmp
  tmp="$dest.new.$$"
  cp "$src" "$tmp"
  chmod "$mode" "$tmp"
  mv -f "$tmp" "$dest"
}
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/fixture" "$APP/Contents/Resources/bin"
install_file ".build/$CONFIG/Conn" "$APP/Contents/MacOS/Conn" 755
install_file ".build/$CONFIG/FakeHerdr" build/FakeHerdr 755
install_file ".build/$CONFIG/FakeCampus" build/FakeCampus 755
for f in fixture-reader.html fixture-lite.html fixture-organizer.html fixture-stars.json fixture-pane-labels.json open-asks.json; do
  install_file "Resources/fixture/$f" "$APP/Contents/Resources/fixture/$f" 644
done
install_file Resources/Conn.icns "$APP/Contents/Resources/Conn.icns" 644
# The `conn` shell command (README "Opening a folder from the terminal"): File > Install 'conn' Command in PATH links it from ~/.local/bin.
install_file Resources/bin/conn "$APP/Contents/Resources/bin/conn" 755
cat > "$APP/Contents/Info.plist.new.$$" <<'PLIST'
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
mv -f "$APP/Contents/Info.plist.new.$$" "$APP/Contents/Info.plist"
# Sign the whole bundle ad hoc, last, so the signature seals Info.plist and every resource above.
codesign --force --sign - "$APP"
codesign --verify --verbose=2 "$APP"
echo "built $APP"
