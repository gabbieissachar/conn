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
./test.sh                  # unit tests (Swift Testing from the Command Line Tools)
```

More options are listed at the top of `run.sh`. Keys: Cmd+K quick switcher, Cmd+1..9 agents (waiting first), Cmd+J next agent waiting on you, Cmd+O / Cmd+S in the editor, Opt+Cmd+1/2/3 Agent / Editor / Herdr screen.

## Known limits

- Panes are drawn at the size Herdr's own screen gave them (an observer cannot resize a pane), so they are narrow in a wide window. Window-sized panes need control mode (decision D3, step 2), which is not built.
- A stream pane has no scrollback: the history button in the pane header opens the pane's recent output as text, and the reader has the full conversation.
- The compose box has only been exercised against the stand-in Herdr. Not yet tried on real Herdr: multi-line text (a newline may submit early), and an agent that is blocked on a question. Herdr's `agent.prompt` rejects a blocked agent, so it may be the better call for non-blocked agents; that needs a lab session.
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
| `tools/` | `fetch-deps.sh` and `deps.lock` (the pin), `measure.py` (footprint and CPU, same method as the 4.09 GB / 15.5% baseline) |

## Safety model

- Panes are observe-only. The app never resizes a pane and has no control-mode path.
- The only write is the compose box (`pane.send_input`: text, then Enter). It is refused in code unless the session is on the `WritePolicy` allow list (`--write NAME` or `HELM_WRITE_SESSIONS`), it waits a few seconds with an Undo, and the text returns to the box if delivery fails.
- Everything that talks to Herdr is in `HelmCore/Herdr`. Session names and pane ids are validated before they reach a socket or a command line.
- Stream bytes are untrusted: CSI parameters are clamped, saved cursors are clamped, frame sizes are checked (500 by 300 cells at most), clipboard and title requests from a pane are dropped, and only http and https links open.
- Observer children are recorded and orphaned ones are ended at the next launch.

## Dependencies and why SwiftTerm is not a SwiftPM dependency

SwiftTerm (upstream `migueldeicaza/SwiftTerm`, v1.99.2, revision in `tools/deps.lock`) is cloned into `.deps/` by `tools/fetch-deps.sh` and compiled as a plain target through the `Sources/SwiftTermVendored/Upstream` symlink. SwiftPM keeps dependency clones as bare repositories, and this Mac's `safe.bareRepository=explicit` git setting refuses to run inside them, so a URL dependency cannot resolve (SwiftTerm's own manifest also declares dependencies it does not use here). Relaxing a git safety setting to build was not done. Upstream is a tools-6.2 package; compiled here under tools 5.9 it builds in the Swift 5 language mode, so its strict concurrency checks are off. The two files upstream generates with a build plugin (`SwiftTermBuildInfo`, an XTGETTCAP reply table) are stubbed in `Sources/SwiftTermVendored/BuildInfoStub.swift`.
