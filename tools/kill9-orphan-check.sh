#!/bin/bash
# Observer children and a killed app. Runs against the stand-in Herdr only (never a real session).
#
# Scenario 1 (reviewer F4): an observer child must not outlive a killed app.
#   start the app and wait for its observer child, kill -9 the app, confirm the child is still there with parent pid 1
#   (the leak), start the app again and confirm the leftover child was ended.
# Scenario 2 (buzz lesson 1): two running instances must not reap each other's children.
#   start instance A and instance B against the same state directory, each with its own observer child; kill -9 A; confirm
#   A's child is orphaned and B's is not; relaunch A. A's orphan must be ended (SIGTERM, then SIGKILL if it ignores that)
#   and B's child, B's receipt and B itself must be left alone.
cd "$(dirname "$0")/.."
D=/tmp/helm-kill9-$UID; mkdir -p "$D"
printf '#!/bin/sh\nexec "%s/build/FakeHerdr" cli "$@"\n' "$PWD" > "$D/herdr"; chmod +x "$D/herdr"
build/FakeHerdr serve --dir "$D/s" --session fake --agents 6 >/dev/null 2>&1 &
FAKE=$!
KILL_AT_EXIT="$FAKE"
trap 'kill $KILL_AT_EXIT 2>/dev/null' EXIT
sleep 1
FAILED=0
fail() { echo "FAIL: $*"; FAILED=1; }
# launch STATE_DIR EXTRA_ARGS...  -> prints the app's pid. Agents 0 and 1 (blocked, done) are static panes: no output after
# the first frame, so their observer never sees EPIPE and really is orphaned by a kill -9.
launch() { local state="$1"; shift; HELM_STATE_DIR="$state" HELM_ARGS="--session fake --socket-dir $D/s --herdr-bin $D/herdr --fixture --web off --background $*" build/Helm.app/Contents/MacOS/Helm >/dev/null 2>&1 & echo $!; }
child_of() { ps -axo pid=,ppid=,command= | awk -v p="$1" '$2==p && /terminal session observe/ {print $1}'; }
ppid_of() { ps -o ppid= -p "$1" 2>/dev/null | tr -d ' '; }
alive() { [ -n "$(ps -o pid= -p "$1" 2>/dev/null | tr -d ' ')" ]; }
# The app opens a stream for its first pane and then switches to the one --select asks for (a second or two after
# launch), so the first child is replaced. Wait until the same single child has been there for two seconds.
wait_child() {
  local app="$1" kid="" last="" stable=0
  for _ in $(seq 1 60); do
    kid=$(child_of "$app" | tail -1)
    if [ -n "$kid" ] && [ "$kid" = "$last" ]; then stable=$((stable + 1)); else stable=0; fi
    last="$kid"
    [ "$stable" -ge 4 ] && { echo "$kid"; return; }
    sleep 0.5
  done
  echo ""
}
wait_gone() { for _ in $(seq 1 30); do alive "$1" || return 0; sleep 0.2; done; return 1; }
owner_of_receipt() { sed -n 's/.*"ownerPid":\([0-9]*\).*/\1/p' "$1"; }

echo "== scenario 1: one app, kill -9, relaunch"
S1=$D/state1-$$; mkdir -p "$S1"
APP=$(launch "$S1" --select 0); KID=$(wait_child "$APP")
echo "app=$APP observer child=$KID"
[ -n "$KID" ] || { fail "no observer child"; kill "$APP" 2>/dev/null; exit 1; }
ls "$S1/observers/"; cat "$S1/observers/$KID.json"; echo
[ "$(owner_of_receipt "$S1/observers/$KID.json")" = "$APP" ] || fail "the receipt does not name the app as owner"
kill -9 "$APP"; sleep 1
echo "after kill -9: child $KID alive=$(alive "$KID" && echo yes || echo no) ppid=$(ppid_of "$KID")"
APP2=$(launch "$S1" --select 2 --quit-after 8); sleep 3
if alive "$KID"; then fail "scenario 1: the leftover observer is still running"; kill "$KID"; else echo "PASS: the leftover observer was ended at the next launch"; fi
[ ! -e "$S1/observers/$KID.json" ] && echo "PASS: its receipt was deleted" || fail "scenario 1: its receipt is still there"
wait "$APP2" 2>/dev/null

echo "== scenario 2: two instances share one state directory"
S2=$D/state2-$$; mkdir -p "$S2"
A=$(launch "$S2" --select 0); B=$(launch "$S2" --select 1)
KILL_AT_EXIT="$FAKE $A $B"
KA=$(wait_child "$A"); KB=$(wait_child "$B")
echo "A=$A child=$KA   B=$B child=$KB"
[ -n "$KA" ] && [ -n "$KB" ] || { fail "an instance has no observer child"; exit 1; }
[ "$(owner_of_receipt "$S2/observers/$KA.json")" = "$A" ] && [ "$(owner_of_receipt "$S2/observers/$KB.json")" = "$B" ] \
  && echo "PASS: each receipt names its own instance as owner" || fail "scenario 2: receipts do not name their owners"
kill -9 "$A"; sleep 1
echo "after kill -9 of A: A's child alive=$(alive "$KA" && echo yes || echo no) ppid=$(ppid_of "$KA"); B's child alive=$(alive "$KB" && echo yes || echo no) ppid=$(ppid_of "$KB")"
[ "$(ppid_of "$KA")" = "1" ] || fail "scenario 2: A's child was not orphaned (it needs to be for the test to mean anything)"
A2=$(launch "$S2" --select 2 --quit-after 10); sleep 4
if alive "$KA"; then fail "scenario 2: the dead instance's observer is still running"; kill "$KA"; else echo "PASS: the dead instance's observer was ended"; fi
if alive "$KB" && alive "$B"; then echo "PASS: the running instance and its observer were left alone"; else fail "scenario 2: the running instance's observer or the instance itself is gone"; fi
[ ! -e "$S2/observers/$KA.json" ] && [ -e "$S2/observers/$KB.json" ] && echo "PASS: only the dead instance's receipt was deleted" || fail "scenario 2: receipts: A's present=$([ -e "$S2/observers/$KA.json" ] && echo yes || echo no) B's present=$([ -e "$S2/observers/$KB.json" ] && echo yes || echo no)"
wait "$A2" 2>/dev/null
kill "$B" 2>/dev/null; wait_gone "$KB" && echo "(B's observer ended with B)"
[ "$FAILED" = 0 ] && echo "ALL PASS" || { echo "SOME CHECKS FAILED"; exit 1; }
