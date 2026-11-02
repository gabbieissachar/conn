#!/bin/bash
# Build Helm.app with the Command Line Tools and SwiftPM. No Xcode.
# usage: ./build.sh          -> build/Helm.app (release)
#        HELM_CONFIG=debug ./build.sh
set -euo pipefail
cd "$(dirname "$0")"
CONFIG=${HELM_CONFIG:-release}
tools/fetch-deps.sh
swift build -c "$CONFIG" --product Helm
swift build -c "$CONFIG" --product FakeHerdr
APP=build/Helm.app
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/fixture"
cp ".build/$CONFIG/Helm" "$APP/Contents/MacOS/Helm"
cp ".build/$CONFIG/FakeHerdr" build/FakeHerdr
cp Resources/fixture/fixture-reader.html Resources/fixture/fixture-organizer.html Resources/fixture/fixture-stars.json Resources/fixture/fixture-pane-labels.json "$APP/Contents/Resources/fixture/"
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>dev.local.helm</string>
  <key>CFBundleName</key><string>Helm</string>
  <key>CFBundleExecutable</key><string>Helm</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>CFBundleDocumentTypes</key><array><dict>
    <key>CFBundleTypeName</key><string>Text</string>
    <key>CFBundleTypeRole</key><string>Editor</string>
    <key>LSItemContentTypes</key><array><string>public.plain-text</string><string>net.daringfireball.markdown</string></array>
  </dict></array>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict></plist>
PLIST
echo "built $APP"
