#!/bin/bash
# List the Conn.app copies Launch Services knows about and drop every one but the real one from its registry.
#
#   tools/lsregister-clean.sh              dry run: print each registered copy and what would happen
#   tools/lsregister-clean.sh --apply      unregister the copies that are not the real one
#   CONN_KEEP=/path/Conn.app tools/lsregister-clean.sh   the copy to keep (default: ~/workspace/conn/build/Conn.app)
#
# Why: macOS opens an app by bundle identifier ("Quit & Reopen" after a privacy switch, `open -b`), and every copy with the same
# identifier is a candidate. Worker worktrees and scratch builds register themselves as dev.local.conn, so a reopen can land on an old one.
# (build.sh now gives non-primary builds dev.local.conn.dev; this clears the copies registered before that.)
# Only the Launch Services registry changes. No file or folder is touched, and a copy that is unregistered still runs when started by its path;
# Launch Services registers it again the next time it is opened through Finder or `open`.
set -euo pipefail
LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister
KEEP=${CONN_KEEP:-$HOME/workspace/conn/build/Conn.app}
APPLY=0
[ "${1:-}" = "--apply" ] && APPLY=1

# One line per registered bundle: "path<TAB>identifier", for identifiers dev.local.conn and dev.local.conn.*.
"$LSREGISTER" -dump | awk '
  /^-{20,}/ { if (path != "" && id ~ /^dev\.local\.conn(\.|$)/) print path "\t" id; path = ""; id = ""; next }
  /^path:/ { sub(/^path:[ \t]+/, ""); sub(/ \(0x[0-9a-f]+\)$/, ""); path = $0 }
  /^identifier:/ { sub(/^identifier:[ \t]+/, ""); id = $0 }
  END { if (path != "" && id ~ /^dev\.local\.conn(\.|$)/) print path "\t" id }
' | sort -u | while IFS=$'\t' read -r path id; do
  if [ "$path" = "$KEEP" ]; then
    echo "keep      $id  $path"
  elif [ "$APPLY" = 1 ]; then
    "$LSREGISTER" -u "$path" && echo "dropped   $id  $path"
  else
    state=present; [ -d "$path" ] || state=missing
    echo "would drop  $id  $path  ($state)"
  fi
done
[ "$APPLY" = 1 ] || echo "(dry run: pass --apply to unregister; nothing was changed)"
