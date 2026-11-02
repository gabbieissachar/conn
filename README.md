# Helm

Native Mac workspace app: Herdr panes, the transcript reader, the organizer and a plain editor in one window. Decisions: see the native app decision ledger kept by the leader-workspaceos firstmate home.

Helm is a client of `herdr server`: Herdr stays the backend and keeps every agent alive when the app quits. The app draws a native sidebar from Herdr's snapshot and events, streams visible panes into a terminal pane, shows the reader and the organizer as web views, edits text and markdown files, and keeps Herdr's own screen in a terminal pane as a fallback.

**What draws the panes.** Decision B2: SwiftTerm is the terminal engine, behind a protocol (`TerminalEngine`). It is the default pane view. A second engine, a 450-line cell grid ported from the prototype, stays selectable with `./run.sh --renderer grid`; it is the one whose output the agents that built this could see in screenshots, so it is the reference when a SwiftTerm pane looks wrong. SwiftTerm also runs the Herdr-screen fallback pane.

SwiftTerm normally draws from a display-link tick that follows its own dirty mark. A pane that gets one burst of output and then nothing (a "needs you" or "done" agent) was slow to draw its first screen on the captain's display, so the engine forces a draw 60 ms after a full frame and 250 ms after the last bytes (`SwiftTermEngine.scheduleNudge`, `HelmTerminalView.nudgeDisplay`). In the one environment it could be measured (no display link ticks at all), the first draw lands 55 to 67 ms after the first frame; whether that matches the delay on a real screen is for the captain to confirm.

## Build and run

Command Line Tools and SwiftPM only. No Xcode.

```
./build.sh                 # build/Helm.app (release), about 5 minutes the first time (SwiftTerm dominates)
./run.sh                   # live: observe-only client of Herdr session "esim"
./run.sh --fixture         # stand-in Herdr with invented agents and pages: safe to screen-share, compose box enabled
./run.sh --fixture --renderer grid   # the same with the cell-grid pane view
./run.sh --session NAME    # another session
./run.sh --write NAME      # let the compose box send to that session (default: none)
./run.sh --text-panes      # poll pane text instead of streaming (works across Herdr protocol changes)
./test.sh                  # unit tests (Swift Testing from the Command Line Tools); HELM_HOSTILE_SCALE=full adds the 2 MB and 12 MB hostile streams
./run.sh --fixture --ui-check   # scripted in-process UI checks (background mode); add no --fixture to run them read-only against session esim
```

More options are listed at the top of `run.sh`. Keys: Cmd+K quick switcher, Cmd+1..9 agents (waiting first), Cmd+J next agent waiting on you, Cmd+Y swap the live pane for its history and back (Esc also goes back), Cmd+= / Cmd+- / Cmd+0 pane text bigger / smaller / back to the fit, Cmd+O / Cmd+S in the editor, Opt+Cmd+1/2/3 Agent / Editor / Herdr screen.

**Scrolling a pane.** A live pane cannot scroll: Herdr re-renders the pane for an observer (a full frame clears the screen and writes every row at an absolute position, later frames rewrite changed rows; a real working pane sampled read-only held 0 line feeds in 19,908 bytes), and a terminal only keeps scrollback when line feeds scroll it. Herdr's ANSI form of `pane.read` for the `recent` source is only the screen too, so styled history cannot be seeded either. Instead the clock button in the pane header, Cmd+Y, or a deliberate upward wheel or trackpad scroll over the pane swaps the live pane for a scrollable snapshot of its history (`pane.read` recent, plain text, newest at the bottom, find bar, Refresh, Copy). The stream keeps running and drawing underneath, so "Back to live" shows a current screen at once. Real, styled, live scrollback needs Herdr to expose it (a history call that keeps colour, or scroll-aware frames) or control mode.

**Pane text size.** The font is the largest (7 to 28 pt) at which Herdr's whole cols x rows grid fits the pane's width and height, refitted on every window or split resize; the grid is centred in the slack. Cmd+= / Cmd+- change a zoom factor (0.6 to 2.0 of the fit) that is remembered across launches; zoomed past the fit the left and top edges crop. A pane that is 59 rows tall is height-bound: rows, not columns, set the size, so a wide window does not make its text larger. A different grid (more columns, fewer rows for the width you have) needs the Herdr pane resized, which is a write and belongs to control mode.

**Organizer and reader.** The Organizer pane opens on its Context view every time it is switched to or its page loads (Helm clicks the page's own Context button; the page is not edited). A link in one pane to the other pane's server (localhost, 127.0.0.1 or ::1, the same port), by click or by `target=_blank` / `window.open`, switches to that pane and loads that exact address, hash kept; any other outside link opens in the browser.

## Test notes (read before launching the app from a script or an agent session)

A test launch must never take the keyboard or the pointer from the person at the computer. The rules:

1. **Background mode.** `--background` (or `HELM_BACKGROUND=1`) makes the process an accessory (no Dock icon, no menu-bar item), never activates it, makes its windows fully transparent and click-through, and has any window that becomes key give it up. Views still lay out and draw, so in-process checks and captures work. Every scripted launch (`--ui-check`, `--shot`, `--tour`, `--selftest`, `--probe-draw`, `--editor-test`, `--send-test`, `--start-fallback`, `--quit-after`) implies it; `--foreground` or `HELM_FOREGROUND=1` opts out. `tools/kill9-orphan-check.sh` and `tools/stall-check.sh` pass it. Going through `open`, use `open -g -j`.
2. **No synthesised input.** No CGEvent, AppleScript or System Events clicks or keystrokes, no cliclick, nothing that moves the real pointer. Drive the UI in-process: the `--ui-check` hooks and direct method calls on the model. Capture with `--shot` / `--tour` (in-process rendering), never by bringing a window forward.
3. **Stop what you start.** Kill every test instance when its check ends (the check scripts do).
4. **Needs a real foreground window?** Do not run it from a script. List it for a person to try by hand. Today that is: the pane's mouse-wheel gesture on a real trackpad, keyboard focus in the compose box, Cmd+= / Cmd+- / Cmd+0 and Cmd+Y typed at the real window, and `tools/measure.py` (it opens a real window on purpose, because drawing cost is what it measures).

## Keyboard ownership (design note, `HelmCore/KeyRule.swift`)

Panes take no keys today, but the rule is fixed before they do:

- App shortcuts always carry Command (Shift or Option may join it: Opt+Cmd+1/2/3 switch the centre view, Cmd+Ctrl+S toggles the sidebar). A chord without Command is never the app's.
- Control and Option (Alt) chords without Command always go to the focused pane (Ctrl-C, Ctrl-R, Alt-B, Esc prefixes); no terminal sends Command chords, so the two sets never clash.
- One chord, Cmd+L, moves keyboard focus between the compose box and the pane. It is ignored while an input method is composing (marked text): then the keys belong to the input method.
- Everything else belongs to whatever has focus.

`KeyRule.route` is the matcher (unit-tested over every modifier combination); `--ui-check` audits every menu shortcut against it. The day a pane takes input, its key view asks `KeyRule.route` before it handles an event.

## Known limits

- Panes are drawn at the size Herdr's own screen gave them (an observer cannot resize a pane), so they are narrow in a wide window. Window-sized panes need control mode (decision D3, step 2), which is not built.
- A stream pane has no scrollback of its own (see "Scrolling a pane"): the history view shows the newest 3000 lines of `pane.read` as plain text, a snapshot, not live. The reader has the full conversation.
- The compose box has only been exercised against the stand-in Herdr. Multi-line messages are refused with a message (a newline may submit early on real Herdr). Not yet tried on real Herdr: an agent that is blocked on a question. Herdr's `agent.prompt` rejects a blocked agent, so it may be the better call for non-blocked agents; that needs a lab session.
- Each visible working pane costs the Herdr server several points of CPU, so streams run only for panes on screen, and stop after 30 s in the background.
- The reader reloads its 19 MB page when it follows a different agent (it only reads its address at load).

## Layout

| Path | What |
|---|---|
| `Sources/HelmCore` | Everything that is not UI: Herdr JSON client with a write gate, store (snapshot + events, reconnect, health ping), pane stream sources, compatibility check, terminal protocol and the cell-grid engine, editor document |
| `Sources/HelmTerminal` | SwiftTerm behind HelmCore's `TerminalEngine`: engine, observe-only view, theme, the fallback pane |
| `Sources/Helm` | The SwiftUI app with AppKit views for the hot paths |
| `Sources/FakeHerdrKit`, `Sources/FakeHerdr` | A stand-in Herdr (JSON socket, pane stream, `herdr` CLI subset) for fixtures, tests and measurements |
| `Sources/HelmStreamTest` | The read-only Herdr stream test (latency, reconnect, load, version checks) |
| `Sources/SwiftTermVendored` | SwiftTerm v1.99.2 compiled unmodified from a pinned clone (see below) |
| `tools/` | `fetch-deps.sh` and `deps.lock` (the pin), `measure.py` (footprint and CPU, same method as the 4.09 GB / 15.5% baseline), `kill9-orphan-check.sh` (one app and two apps killed with `kill -9`, stand-in only), `stall-check.sh` |

## Safety model

- Panes are observe-only. The app never resizes a pane and has no control-mode path.
- The only write is the compose box (`pane.send_input`: text, then Enter). It is refused in code unless the session is on the `WritePolicy` allow list (`--write NAME` or `HELM_WRITE_SESSIONS`), it waits a few seconds with an Undo, and the text returns to the box if delivery fails.
- Everything that talks to Herdr is in `HelmCore/Herdr`. Session names and pane ids are validated before they reach a socket or a command line.
- Stream bytes are untrusted: CSI parameters are clamped, saved cursors are clamped, frame sizes are checked (500 by 300 cells at most), clipboard and title requests from a pane are dropped, and only http and https links open.
- Observer children get one receipt each (`observers/<pid>.json`: pid and start time of the child and of its owner). A launching instance ends a child (SIGTERM, then SIGKILL after about a second) only when its owner is gone, it is still the same process, its parent is launchd and its command line is still ours; another running instance's children are never touched.

## Dependencies and why SwiftTerm is not a SwiftPM dependency

SwiftTerm (upstream `migueldeicaza/SwiftTerm`, v1.99.2, revision in `tools/deps.lock`) is cloned into `.deps/` by `tools/fetch-deps.sh` and compiled as a plain target through the `Sources/SwiftTermVendored/Upstream` symlink. SwiftPM keeps dependency clones as bare repositories, and this Mac's `safe.bareRepository=explicit` git setting refuses to run inside them, so a URL dependency cannot resolve (SwiftTerm's own manifest also declares dependencies it does not use here). Relaxing a git safety setting to build was not done. Upstream is a tools-6.2 package; compiled here under tools 5.9 it builds in the Swift 5 language mode, so its strict concurrency checks are off. The two files upstream generates with a build plugin (`SwiftTermBuildInfo`, an XTGETTCAP reply table) are stubbed in `Sources/SwiftTermVendored/BuildInfoStub.swift`.
