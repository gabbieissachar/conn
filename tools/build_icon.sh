#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
ICON_BUILD=.build/conn-icon
mkdir -p "$ICON_BUILD"
swiftc -module-cache-path "$ICON_BUILD/module-cache" tools/make_icon.swift -o "$ICON_BUILD/make_icon"
"$ICON_BUILD/make_icon" --output "$ICON_BUILD/concepts" --preview docs/icon-concepts.png --iconset "$ICON_BUILD/Conn.iconset" --selected command-c
iconutil -c icns "$ICON_BUILD/Conn.iconset" -o Resources/Conn.icns
echo "built Resources/Conn.icns (command-c)"
