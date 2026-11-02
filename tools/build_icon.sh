#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
ICON_BUILD=.build/conn-icon
mkdir -p "$ICON_BUILD"
swiftc -module-cache-path "$ICON_BUILD/module-cache" tools/make_icon.swift -o "$ICON_BUILD/make_icon"
"$ICON_BUILD/make_icon" --output "$ICON_BUILD/concepts" --preview docs/icon-concepts.png --iconset "$ICON_BUILD/Conn.iconset" --selected linked-loops
# macOS 26.4 can reject valid iconsets, so keep a usable 512 px fallback.
if ! iconutil -c icns "$ICON_BUILD/Conn.iconset" -o Resources/Conn.icns >/dev/null 2>&1; then
  sips -s format icns "$ICON_BUILD/Conn.iconset/icon_512x512.png" --out Resources/Conn.icns >/dev/null
fi
echo "built Resources/Conn.icns (linked-loops)"
