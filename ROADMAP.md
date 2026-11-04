# Conn roadmap

What Conn has shipped, what comes next, what is already decided, and what still needs the owner. Last updated 2026-11-03, on the Conn rename branch.

Update rule: every Conn change updates this file in the same branch (see "How to keep this current" at the end).

## Short answer

Conn is a working replacement for the Herdr part of the old setup. It draws the live sidebar and panes of a Herdr session, shows the reader and organizer as web views, edits text files, and has one guarded write (the compose box). It is **observe-only**: it cannot resize a pane, and the compose box has only been tried against the stand-in Herdr. 111 unit tests and 64 scripted UI checks against the fixture pass. Memory fits the budget (about 1.0 to 1.1 GB for the whole setup against 4.1 GB before). The CPU target passes on Conn's added share (D6). Several things were checked in process only and need a person at a real screen.

**Next three steps, in recommended order:**

1. **Try `main` on a real screen** (N1). A person runs the short hand-check list below. It settles the items that no scripted check can see (trackpad scroll, keys typed at the window, text size on the Retina display, pane first draw).
2. **One small fix that needs nothing from Herdr** (N2). Stop showing a superseded reader load as "not reachable". Wide panes wait for control mode (W1).
3. **Set up a Herdr lab session, then build control mode** (N4, N5). The lab step is unblocked: a running `default` session now exists beside `esim`. Window-sized panes need a pane resize, which is a write. A lab session is the safe place to test it, and it also settles compose-box questions that are open on real Herdr (N6).

## Done

All prior commits are on `main`. Nothing was ever pushed.

| Piece | What it gives the user | Commits |
|---|---|---|
| Repository and build | Local repo, SwiftPM only (no Xcode), SwiftTerm v1.99.2 built from a pinned clone | `0cb352c`, `f9402da` |
| Herdr core | JSON client with a write gate, store (snapshot, events, reconnect, health ping), pane stream, text fallback, compatibility check, stand-in Herdr for tests | `0cce272`, `24b1436` |
| Mac app, first slice | Native sidebar (waiting agents first, state glyphs), live observe-only panes, compose box (off unless the session is allowed, Undo window, multi-line refused), reader and organizer as web views, plain text and markdown editor, Herdr's own screen as a fallback pane | `e2e1293`, `4b3feb6`, `0db0215`, `34c3ed0` |
| SwiftTerm panes | SwiftTerm is the default pane view (decision B2). A forced draw makes a quiet pane appear at once | `ded2fc7`, `69fb94e` |
| Fast agent switching | Cmd+K quick switcher, Cmd+1 to 9, Cmd+J (next agent waiting on you), Dock badge, menu-bar count, compare view, Open Recent, Find | `a5004a0`, `2be3f7a`, `6f11a0d`, `a05f03f` |
| Safe on real Herdr | Version check with a text-pane fallback (`--text-panes`), orphan cleanup after a crash, refusal of the test hooks against a real session, stand-in refuses to replace a live socket | `679dd7c`, `91b26cc`, `fedf609`, `b5ec793`, `8baa659`, `966b0ab` |
| Review fixes and first-slice close | All 15 reviewer findings fixed and re-verified, none open | `00cbe06`, `9739046`, `8e3aaa4`, `367fa42` |
| Scripted checks | `--ui-check` drives the real UI paths in process; kill -9 and whole-app freeze checks | `0e0cb2c`, `73e38dc` |
| Organizer fixes | The Organizer tab loads when switched to; it opens on its Context view; links between Conn's two web panes stay in Conn | `0fe2759`, `599e0f6` |
| Observer receipts (buzz lesson 1) | One receipt per stream child; only a dead owner's orphans are ended; two-instance kill check | `79263cc` |
| Hostile bytes (buzz lesson 5) | 11 tests against SwiftTerm; found and fixed an unclamped resize and a character set that survived a full frame | `13fb610`, `8e9c489` |
| Keyboard ownership (buzz lesson 3) | Command-only app chords, Ctrl and Alt reach the pane, one focus toggle; tested matcher and README note | `c9feb36` |
| History view | Header button, Cmd+Y, Esc or an upward scroll swaps the live pane for a scrollable plain-text history | `5ede863`, `0a64534` |
| Pane text size | Largest font that fits Herdr's whole grid, plus Cmd+= / Cmd+- / Cmd+0 zoom, remembered | `9e1f709` |
| Test mode that never takes focus | `--background`, implied by every scripted launch; documented rules for later sessions | `1df1bbb`, `83cd037`, `b3d4064`, `5e5dbba`, `93c98a2` |
| Reader tab fix | The Reader tab showed the Organizer once the Organizer had been opened; the web host now holds only the selected pane's page; regression check added | `0a491c0`, `4a1f2dd`, `e6b863a` |
| Starred sessions row | The Reader pane's header row no longer says "Reader". It holds one chip per session starred in the reader (read from the reader's own star list, never written). A click opens that session, the chip on screen is filled, a drag reorders the chips and the order is kept across launches. A star added or removed in the reader shows within 2 s. More chips than fit scroll sideways; with nothing starred the row says where to star. 14 unit tests, fixture and live `--ui-check` steps | `d52a7ef`, `999a21d`, `c27b5c5` |
| In-place pin | An agent selection or a starred chip switches the reader in place (only the address fragment changes) when the page on screen follows an address change: no 19 MB page load. Measured on the live reader (Chrome, 18 switches): 211 ms median in place against 1,369 ms for a load. An older reader without the handler, a first load, another page or a failed in-place change still load the page. 8 `--ui-check` steps (window marker survives, fallback loads, first load, other page, real reader) and 1 unit test | `d74e8e2` |
| Working agents first | The agents list (and so Cmd+1 to 9 and next / previous agent) now orders needs you, working, done, idle, unknown, Herdr's order inside a state; before, done sat above working. The workspace and tab rolled-up state is unchanged (needs you, then done, then working): the sort rank and the rollup rank are now two separate properties. Header label reads "working first". Cmd+J (needs you plus done) is unchanged. 3 unit tests | `f84043c` |
| Agent panel names | Full names in the AGENTS sidebar wrap to two lines, truncate only the end of the second line, and show the full name on hover. | This branch |
| Conn rename, state migration and icon | Renamed the app, SwiftPM targets, bundle, paths, environment variables and visible labels from Helm to Conn; first launch preserves old app-support state and UserDefaults; added two migration tests; added three reproducible flat icon concepts, a preview sheet, and the selected Linked Loops `.icns`, the captain's choice | `4db25a5` |

Measured against the decision D5 target (under 1.2 GB and 6% idle CPU, baseline 4,093 MB and 15.5%):

- Memory: whole setup 1,033 to 1,120 MB in quiet windows with both servers and the reader page open. It passes with little room.
- CPU: Conn adds about 3 points (0.8 to 1.25% in the app, 2 to 2.4 in the Herdr server). The whole setup was 3.2 to 4.4% in quiet windows, but 7 to 23% on busy windows because of the reader's Python worker, which Conn does not control. See D6.
- Each visible working pane costs the Herdr server 3 to 9 points. Panes stream only while visible and stop after 30 s in the background.

## Next

| ID | Item | Why | Depends on | Source |
|---|---|---|---|---|
| N1 | Hand-check `main` on a real screen: (1) trackpad scroll up over a live pane opens the history; (2) Cmd+Y, Cmd+=, Cmd+-, Cmd+0 typed at the window; (3) a needs-you or done pane draws at once, also on the way back from history; (4) the fitted text looks right on the Retina screen; (5) the Organizer opens on Context; (6) Organizer then Reader shows the reader every time; (7) the compose box takes keyboard focus; (8) the starred row: drag a chip over another and drop it (it follows the pointer, the order holds after a relaunch), and star or unstar in the reader to see the row follow within 2 s | Scripted checks cannot see a real display, a real trackpad or typed keys | A person at the Mac | Session 2 report s6; reader fix report "How to confirm by hand"; first-slice report "Renderer" |
| N2 | A superseded reader load is not an error: ignore `NSURLErrorCancelled` in the two `didFail` handlers of `WebBox`, and add a check that supersedes a load and watches the phase | Flipping back to the Reader within a second or two can flash "Reader server not reachable". Still present on `main` | Nothing | Reader fix report "Adjacent finding" |
| N4 | Provision a Herdr lab session | Control mode writes to panes, and restart, sleep, version change and true latency were never tested on real Herdr. The lab helper's precondition is met since 2 Nov: one `default` session runs beside `esim` | Nothing | First-slice report s1; contrarian review verdict 2 |
| N5 | Control mode and window-sized panes (D3 step 2): Conn takes resize control of a pane | Fixes narrow panes at the root (W1), and is the base for any later write | N4; keyboard rule (done); request-id design from buzz lesson 2 | Decision D3; README "Known limits" |
| N6 | Compose box on real Herdr: a blocked agent, multi-line text, and whether `agent.prompt` is the better call for agents that are not blocked | Only tried against the stand-in. `agent.prompt` rejects a blocked agent | N4 | First-slice report "Compose caveats"; README "Known limits" |

## Later

| ID | Item | Why | Depends on | Source |
|---|---|---|---|---|
| L1 | Stop control (interrupt one agent, with a pending state until it takes effect) | A stuck agent today needs the Herdr screen. Interrupt first, a request id on every control, and cancel a pending prompt before its turn | N5. Deferred, see H1 | Buzz report s6 lesson 2, s7 H1 |
| L2 | Native reader | Cuts the 255 to 430 MB WebKit cost. Needs a bounded journal that evicts to about 90% of the cap, not to the cap | A real need for the memory; reader state kept in browser storage does not move into the app | Contrarian design review 4.3; buzz lesson 4 |
| L4 | Real scrollback in a live pane | Herdr frames never scroll, so a terminal cannot keep lines | Herdr exposing history with colour, or control mode | Session 2 report s1 |
| L5 | Markdown highlighting in the editor | Editor is plain text today | Nothing | First-slice report "What is next" |
| L6 | Lower graphics memory in the app (78 MB IOSurface plus 41 MB owned graphics for a retina window) | Pane footprint goes from 93 MB to 190 to 230 MB while streaming | Nothing; not tried | First-slice report s3 |
| L7 | A real system sleep with the app running | Reconnect on wake is coded but never seen on real Herdr | N4 or the captain's go | First-slice report s1 |
| L8 | Check that the sidebar marks agent states as stale while the link is reconnecting | Buzz showed "working" as current when the stream was quiet | Nothing | Buzz report s5 "Liveness" |
| L9 | Environment allowlist for any child that runs user code | Today's children are `herdr` CLI processes and Conn holds no secrets | The day Conn launches a shell or agent itself | Buzz report s6 smaller notes |
| L10 | Native iPhone app | Phone keeps the web reader and organizer meanwhile | Mac slice settled; paid Apple account and Xcode at that point (E3, E4); Tailscale HTTPS and sign-in (B5) | Decisions E1 to E4, B5 |
| L11 | A ShopBack GitLab repo | Local repo until Conn is shared (B3) | A decision to share | Decision B3 |
| L12 | If Conn ever shows token use, keep "unknown is not zero" | Avoids a false zero in a usage figure | A usage display | Buzz report s5 |

## Decided and deferred

Do not re-ask these unless the facts change.

| ID | Decision | Reason |
|---|---|---|
| A1 | VS Code is quit entirely; editing is a feature | Settles design decision 7: a real editor, not read-only viewing |
| A2 | Both resources and coherence are reasons for going native | Candidate workflows are still to be discovered |
| A3 | Go straight to the native app; no interim terminal plus Safari setup | The owner chose it against the review's advice |
| B1 | Herdr stays the backend; Conn is a client of `herdr server` | Herdr is cheap (about 58 MB) and keeps agents alive when the app quits |
| B2 | SwiftTerm, behind a `TerminalEngine` protocol | Upstream `migueldeicaza/SwiftTerm`, MIT. The cell-grid engine stays as `--renderer grid` |
| B3 | New local repo now, ShopBack GitLab repo when shared | Nothing needs a shared repo yet |
| B4 | Plain text and markdown editor with save | Not a full code editor |
| B5 | Phone: Tailscale plus passcode; native iPhone later via Tailscale HTTPS and sign-in | Fine for the web pages today |
| D1 | First slice: native sidebar, panes, compose box, reader and organizer as web views, editor, Herdr's screen as a fallback pane | Shipped |
| D2 | A read-only stream test before building native panes | Done for decode, cold start, stall, client cost and CPU. Restart, sleep, version change and true latency are still open (N4) |
| D3 | Step 1: observe-only panes at Herdr's width. Step 2: control mode once native panes are stable | Step 1 shipped. Step 2 is N5 |
| D4 | Editor ships in the first slice | Shipped |
| D5 | Success: whole setup under 1.2 GB and 6% idle CPU, measured like the 4.09 GB and 15.5% baseline; a miss means stop and rethink | Memory passes. CPU passes on Conn's added share (D6) |
| D6 | What the D5 CPU target measures: judge Conn's added share and still report the whole-setup figure (owner answer D6=a, 2 Nov) | Conn adds about 3 points, under the 6% target. The whole setup (3.2 to 4.4% quiet, 7 to 23% busy) is reported beside it, because Herdr and the reader's Python worker use that much with no app running. D5 CPU: passed on this basis |
| W1 | Wide panes wait for control mode (owner answer W1=b, 2 Nov) | No column fix now. Narrow panes on wide grids are fixed at the root by N5 |
| W2 | Shortcuts read as "Command required" are accepted (W2=accept, 2 Nov) | Opt+Cmd+1/2/3, Opt+Cmd+R, Opt+Cmd+F and Cmd+Ctrl+S stay. No terminal sends Command chords, so they cannot clash |
| W3 | The wheel opens the history view (W3=keep, 2 Nov) | A deliberate upward scroll swaps the live pane for the history. N1 still checks the feel by hand |
| E1 | Mac app first; iPhone keeps the web reader and organizer | Native iPhone later |
| E2 | Make the web reader lean on the phone (one conversation at a time) | Reader-side work, not Conn |
| E3, E4 | Paid Apple account and Xcode only when an iPhone build starts | Mac slice builds with Command Line Tools and SwiftPM |
| H1 | Stop control deferred | Steering through the compose box is enough until a need shows up (L1) |
| Pane stream, not a socket | Observe by the `herdr terminal session observe` stream, with a text fallback | Herdr's JSON API has no pane byte stream. The stream sits on an internal protocol that went from version 5 to 22 in six months, so the version check and text fallback stay |
| Observers cannot resize | Panes are drawn at the size Herdr gave them | Resize is a write and belongs to control mode |
| Compose box is the only write | One write path behind a per-session allow list | Safety model in the README |
| Native reader | Deferred (L2) | The web reader stays until memory or coherence needs it |
| R1 | Reader-side `hashchange` change: land it (owner answer R1=a, 2 Nov) | The smallest win left on reader switching. The pmos reader change landed (`2a915eb` on `nguyen/workspace`) and Conn's own part (skip the reload) is done: see Done, "In-place pin" |
| Buzz | Take ideas, no code | Rust and TypeScript, Apache-2.0, a different problem (headless agents). Lessons 1, 3 and 5 are done; lessons 2 and 4 are L1 and L2 |
| Other stacks | Tauri, gpui, libghostty, cmux, Option 0 (Herdr in a plain terminal plus a browser) not pursued | A3 and B2 settled the path |

## Open questions

None open. Reply with keyed answers (`R2=...`) when one is added.

## How to keep this current

- Each Conn change updates this file in the same branch. A change that ships a piece adds a row to Done with its commit ids and removes or edits the Next or Later row it closes. A change that finds new work adds a row with its source.
- Commit ids go in once the commit exists: add them in a follow-up commit on the same branch, or amend before the branch is merged.
- When the owner answers a keyed question, move it to "Decided and deferred" with the answer and its reason, and delete the card.
- Keep "Short answer" true: re-check the next three steps and the test counts at every update.
- Keep it self-contained: cite decision ids, commit ids and report sections, never paths outside this repository.
- Plain language, short sentences, no em dash.
