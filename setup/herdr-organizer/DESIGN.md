# Herdr restart tools - design note

Status: decided in the step 1 brainstorm (2026-10-04). Built on branch `fm/herdr-organizer-app-tools`.
App: `apps/wip-herdr-workspace-organizer.html`, served by `setup/serve.sh`.

## Purpose and flow

One browser page to run and understand the safe computer-restart flow for named Herdr sessions.
The user is the person restarting their own machine; the page is a local cockpit, not a remote console.

1. Inspect sessions (default session never selectable).
2. Verify identities per pane; apply the verified rows.
3. Resolve the panes that stay manual (manual identity form).
4. Run the prepare preflight; acknowledge only intended failures; seal a bundle.
5. Restart the computer (checklist item only).
6. After boot: attach each bundled session in a terminal, run the reconcile preview, copy the confirm command and run it in a terminal.

The page also produces a redacted report of the verify and preflight results for sharing.

## Decisions

| # | Decision | Chosen |
|---|---|---|
| 1 | What the page executes itself | Tier 0 and tier 1 only (below). Tier 2 and 3 are copy-only. |
| 2 | Manual identity, folder mismatch | Refuse unless the explicit "folder differs, I confirm" override is sent; the server re-checks it. |
| 3 | Share report labels | Workspace, tab and session names masked by default (`Workspace 1`, `Tab 3`, `Session A`); a per-report toggle adds real names. Pane ids always stay. |
| 4 | Default session scope | All running non-default sessions selected. Unticked running sessions get a visible warning. The server always receives an explicit list. |
| 5 | v1 scope | Core plus per-item preflight acknowledgements. Manual identity is paste-an-id only. |
| 6 | Clean up empty tabs in every workspace (asked for mid-build) | A card in the Workspaces view. The page runs the read-only preview for every workspace and copies the exact commands. Closing tabs is copy-only. |

## Authority tiers

The server enforces the tiers. The buttons only reflect them.

| Tier | Actions | Page behaviour |
|---|---|---|
| 0 read-only | session list, snapshot, verifier report, preflight-only, cleanup-empty-tabs preview, reconcile preview, bundle list, share report | Runs it |
| 1 private local writes, reversible | verifier `--apply`, save manual identity, seal bundle | Runs it behind an explicit confirm; the server re-validates every parameter |
| 2 changes live Herdr or sends input into panes | `reconcile --confirm`, `rollback-reconcile`, archive, restore, move or archive tabs, `cleanup-empty-tabs --execute`, `/status` capture, resume replay | Shows the exact command and its effect; the user runs it |
| 3 restart | restarting the computer or Herdr | Checklist item only |

The page never runs `herdr-organizer archive`, restore, or anything that stops, closes or recreates real sessions.

## Cross-site protection

`setup/serve.sh` sends `Access-Control-Allow-Origin: *` on every response and its listener had no host argument (it bound all interfaces).
Any web page the user visits could otherwise call a write endpoint on localhost.
Every `/api/herdr-organizer/*` request therefore passes these checks, all covered by tests:

- The listener binds to loopback only (`127.0.0.1` and `::1`). This changes the whole server, not just these routes.
- The Host header must be one of `localhost`, `127.0.0.1`, `[::1]` on the served port (defeats DNS rebinding).
- `Origin` is required on POST and must equal the served origin exactly (scheme, host and port). On GET it may be absent (same-origin) but must match when present.
- `Sec-Fetch-Site`, when sent, must be `same-origin` or `none`.
- A per-server-start random token (32 random bytes) is handed out by `GET /api/herdr-organizer/token` and must come back in the `X-Herdr-Organizer-Token` header on every other call, compared in constant time. The custom header forces a CORS preflight for any cross-site caller.
- POST bodies must be `application/json`.
- These routes are dispatched before the shared CORS and OPTIONS handler and never send `Access-Control-Allow-*` headers. A preflight to them is answered 403.
- Only one tier 1 action runs at a time (409 otherwise); child processes have timeouts and bounded output.
- Child processes never inherit `HERDR_SESSION`, `HERDR_PANE_ID` and the other Herdr context variables from the shell that started the server. `register` prefers the current pane over explicit pane arguments, so an inherited pane id would register the wrong pane.

The older `POST /api/herdr-workspace-organizer/snapshot` stays untouched (fixed command, no input).

## Fixed-action allowlist

One dispatcher, `POST /api/herdr-organizer/run`, body `{action, params}`.
The browser names an action and sends validated parameters; it never sends a command, an argument list or free text that reaches a shell.
Commands are spawned with argument arrays (never a shell) and fixed argument shapes.

Validation:

- Session name: must appear in `herdr session list --json` output, be running, not be `default`, and not start with `-` (a stopped session on this machine is literally named `-h`).
- Pane, workspace and tab ids: match `^w[A-Za-z0-9]+(:[pt][A-Za-z0-9]+)?$` and exist in the live pane list of the named session.
- Bundle id: pattern plus presence in the bundle list. A bundle is only eligible after every member of its manifest is validated against the live `herdr session list`: it must name at least one session, every member must be a well-formed, distinct session name, none may be the default session, and Herdr must know every member. A member that is merely stopped stays eligible but must be attached before the preview runs. The preview repeats this validation immediately before it starts the tool, so a bundle made outside the page cannot reintroduce the default session. Every component of a bundle (the state folders, the bundle folder, `manifest.json`, the `ready` marker and the journal file) must be a real directory or a regular file; a link is refused and never read through.
- Pane write path: one strict validator for a manual identity save. The pane must be listed exactly once; its workspace, tab and pane ids must be well formed and belong to the same workspace; its folder must be present, absolute, canonical (no `.`, `..`, doubled or trailing slashes), free of control characters, and an existing directory. The folder is resolved to its real path, and the store check and the registry write both use the normalized values, never the raw pane list. A pane that fails stops the save before the store check or the registry starts.
- Acknowledgements: accepted only when the exact `session|workspace|tab|pane` (or `session|workspace`) identity appears in the latest preflight failure list. No free text, no global bypass.
- Unknown params and unknown actions are rejected.

Copy-only commands are also built on the server, from validated values only, so a pasted command can never carry unvalidated text.

## Manual identity

Panes offered: only panes the verifier did not verify. A manual save cannot overwrite a verified identity.
Checks, cheapest first:

1. Format: UUID shape for the chosen client.
2. Exists in the real client store (Claude project files; Codex session index and rollouts), via the verifier's own `ClaudeStore` and `CodexStore` classes in a read-only helper.
3. The store's recorded folder equals the pane's current folder, otherwise refused unless the override is sent. A store that records no folder for that session cannot be matched either, so it needs the same override (with its own message).
4. Not already registered to another pane (hard refusal; the page shows a copy-only remove command).

Each save also requires a confirm token naming the pane, a pane whose client matches the pane's detected agent, and an identity check from the last hour that found that pane unverified (a verified identity is never overwritten). The override cannot bypass layer 4.

Layer 3 is the independent cross-check: a check that only proves an id exists cannot prove it is the right one.
The id travels browser to server in a JSON body, then to `agent-session-registry.py register --allow-no-herdr` as one short-lived process, and is never logged or echoed.
Afterwards the page shows only the first 4 and last 4 characters.
Because `register` only takes `--session-id` on its command line, the id is visible to same-user `ps` for the life of that process (see companion tasks).

## Independent review follow-ups

An independent review of this branch confirmed the HTTP guard (token, exact Host and Origin, preflight and form content-type rejection, no shell, fixed allowlist) and asked for two fixes before landing: bundle member validation against the live session list, and the strict live-pane validator for the write path. Both are done above, with a fixture test for each failure shape that asserts the tool never starts. It also asked for the page to stop falling back to the raw static snapshot (done: the page only reads the snapshot through the server, which refuses one that carries a private value) and for symlink checks on bundle components (done).

Kept as documented follow-ups:

- The manual session id is on the command line of the registry's `register` call for the life of that one process. It is never echoed or logged. Accepting it on stdin is companion task 2 below and is the next privacy hardening step.
- The listener change in `setup/serve.sh` makes every app that script serves loopback-only, which removes LAN access to the unrelated local apps. That is the intended protection for this cockpit, but confirm it is intended for the shared server before release.
- The reviewer could not complete a live visual check, so a second person should open the page and look at it before release. The author checked it in a browser at desktop and 390 px width.
- The raw snapshot file is still reachable through the shared static file handler, which sends a wildcard CORS header. The page no longer uses it. Closing that is outside this change.

## Share report

Built on the server, by construction, from an allowlist of fields: pane id, classification, candidate count, exact-match count, evidence categories, failure kind and counts, and the preflight summary.
Raw tool output is never passed through.
A second-layer leak scan then rejects the report if it finds UUID-like strings, `/Users/` paths, socket paths, `resume` command text or a bundle id; if it trips, no report is produced.
The report is markdown with a header listing what is excluded; the page offers copy and download and uploads nothing.
To hand it to someone: read it once, then paste it into Slack or a ticket. Session ids, resume commands, private paths and bundle ids never appear in any mode.
The leak scan and the masking are covered by tests that plant fake leaks.

## Sessions and the restart gap

Bundles are listed from the tool's own private folder (`bundles` action): only the id, time, bundled session names and readiness are returned, never the folders in a manifest. Whether the computer has restarted since a bundle was sealed comes from the bundle's seal time against the machine's boot time, so it survives the browser and the server restarting. A bundle whose reconcile journal already exists is a finished cycle: a fresh check on the page starts a new one.
`reconcile-preview` runs the tool's own read-only `reconcile-all --bundle ID` (never `--confirm`) once every bundled session is running, and returns adopt, rebuild and ambiguous counts per session plus the copy-only confirm, resume, rollback and extra-copy commands, built from the validated id.

Pane ids are unique only inside one session, so every action uses `session + pane`.
The browser's memory does not survive a restart, so the page derives the current step from real state:

| Fact | Step |
|---|---|
| Ready bundle exists and a bundled session is not running | Attach that session in a terminal |
| All bundled sessions running | Reconcile preview is available (the page runs it) |
| Preview clean | Copy the confirm command and run it in a terminal |

Source of truth is the system; the checklist is a projection of it. Only unprovable steps ("I restarted") stay informational.
The preflight is always called with an explicit `--session` list, because without it Herdr selects every running session.

## Clean up empty tabs in every workspace

`herdr-organizer cleanup-empty-tabs` only takes one `--workspace`, so the page does the fan-out.
`cleanup-preview {session}` lists the live workspace ids (pattern `^w[A-Za-z0-9]{1,10}$`, taken from the live pane list), runs the preview for each with at most four at a time, and aggregates the result: tabs to close per workspace, tabs the tool protects (agent, resumable session, non-shell process), and workspaces where the tool keeps the last tab.
The response also carries two copy-only commands built from those validated ids: a loop that previews every workspace, and a `&&`-joined `--execute --confirm` chain for exactly the workspaces that have something to close.
The page never runs the execute form. The tool recomputes what is eligible when it runs, so a stale preview cannot close a protected tab.

## Architecture

All new code is isolated under `setup/herdr-organizer/` so `serve.sh` stays a thin shell (its Node program lives in a bash string, which is hard to test).

- `api.js` - request guard and dispatcher; `serve.sh` requires it and delegates `/api/herdr-organizer/*` before the CORS handler.
- `adapter.js` - the only place that spawns Herdr tooling. Fixed argument builders, and parsers for the verifier and preflight text output. The runner is injectable so tests use fixtures.
- `guard.js` - Host, Origin, Fetch-Metadata and token checks.
- `redact.js` - share report builder and leak scan.
- `store_check.py` - read-only store and folder check for manual identity (imports the verifier's store classes).
- `test/` - `node --test` tests with fixtures.

The tool root defaults to `personal/01-System/setup/herdr` and can be overridden with `HERDR_ORGANIZER_TOOL_ROOT`, so tests and local runs can use a scratch copy and never write into a real registry or bundle directory.
`HERDR_LAB_HELPER`, when set, is passed through to the organizer (it already routes Herdr calls through the isolated lab).

## Out of scope for v1

- Running `reconcile --confirm`, rollback, archive, restore or tab moves from the page.
- `/status` capture (sends input into panes), resume replay, Herdr integration install, auto-recovery at login.
- Candidate picker for manual identity (masked ids plus last-activity time), remote or multi-machine access.

## Companion tasks for `personal` (firstmate to dispatch)

The page is built against the interface as it exists today, through the adapter. These would remove parsing and exposure risk:

1. JSON output mode for `herdr-agent-verify-identity` and for the `prepare-restart-recovery` preflight (stable fields instead of text parsing).
2. `register` accepting the session id on stdin so it never appears in `ps`.
3. A check-id option on the verifier (exists in store, folder matches, already registered) so the page does not import store classes.
4. A `state-root` override environment variable for the organizer and registry, so isolated runs do not need a scratch copy of the scripts.
5. Verifier speed, the biggest practical problem found. `ClaudeStore.records()` and `CodexStore.records()` re-walk and re-read every session file on each call, and `verify_pane` calls them up to three times per pane (`agent_identity_verifier.py` lines 341, 372, 390, 415, 450 and 480). With 24 panes and about 540 Claude session files that is roughly 40 s of CPU, and several minutes of wall time on a busy machine. Memoizing the record list for the life of one run (a per-run cache passed through `stores`) would make it about one pass instead of one per pane per lookup. Related: `cleanup-empty-tabs --all-workspaces` (one snapshot instead of one process per workspace) and progress output for the verifier.
6. Optional: a list-candidates command that returns masked ids and last-activity times, for a later candidate picker.

## Findings from real runs

- The identity verifier is slow on a busy machine: about 40 s of CPU, and several minutes of wall time with a load average near 30. The server allows 15 minutes for the verifier (10 for the preflight), shares one run between identical in-flight requests (a page reload or second tab does not start another), and the page does not auto-run it on load. It shows the elapsed time while it waits. A run that is stopped for taking too long is reported as a timeout (HTTP 504) rather than as a broken tool; on this machine the first real checks hit that limit while the load average was above 100 (confirmed through the API: a real identity check was stopped at 913 s with the timeout message, and the real registry files were untouched).
- The preflight reads the registry manifest next to the tool scripts. A scratch copy of the scripts without that manifest reports every agent as unverified, so isolated copies are for writes only; read-only checks against a real session use the real tool root.
- A stopped Herdr session on this machine is literally named `-h`; session names are therefore never allowed to start with a dash.

## Test isolation notes

- Local runs use an untracked symlink `personal/01-System` to the user's checkout (never committed) for read-only access, with `HERDR_ORGANIZER_TOOL_ROOT` pointing at a scratch copy of the tool scripts for anything that writes. The link sits inside the empty `personal/` directory because git refuses a symlink at the submodule path itself.
- Read-only Herdr commands against a real session are fine; anything that changes state goes through the isolated lab helper or fixtures.
- Lab availability: the lab helper refuses to provision because it requires exactly one running default Herdr session and the default session is stopped on this machine (`fleet-state tripwire requires exactly one running default session`). No session was started to work around it. Lab-dependent checks were done with fixtures instead: the server tests fake the `herdr` binary, and `test/integration.test.js` runs the real registry and store check (Python) against a temporary copy of the tool scripts, a synthetic Codex store and a faked `herdr`, so nothing touches a real Herdr session, the real registry or the real client stores. `--apply`, a manual save and a seal were never run against the real session.
- `python3 -m unittest setup/herdr-organizer/test/test_store_check.py` covers the store check with synthetic stores; `node --test setup/herdr-organizer/test/*.test.js` covers the server.

## Build log

- Phase 1 (read-only views, share report, clean up empty tabs in every workspace): done. 48 server tests pass. Driven in a browser at desktop and 390 px width against the real `esim` session and captured real verifier and preflight output.
- Phase 2 (guarded actions: apply verified identities, manual identity form, per-item acknowledgements and seal): done. Each action needs a confirm token and runs one at a time. 64 server tests and 9 store-check tests pass; the real registry write is covered by the integration test (private 0600 file in a 0700 directory, duplicate and folder guards). Driven in a browser against a fixture-backed server: apply confirm, folder-differs override, masked result, acknowledgement ticks, re-check, seal.
- Phase 3 (sealed bundle list, restart checklist derived from machine state, reconcile preview and copy-only confirm and rollback commands): done. 69 server tests pass. The checklist, the not-attached state, the preview counts and the copy buttons were driven in a browser against a fixture-backed server with temporary bundles, at desktop and 390 px width. HTML in labels was confirmed to render as text.
- Review fixes: bundle members are validated against the live session list (default, unknown, missing, malformed and repeated members are incompatible, and no preview process starts), the preview re-validates immediately before spawning, bundle components that are links or not regular files are refused, the manual identity write path uses one strict live-pane validator with normalized values, and the page no longer falls back to the raw static snapshot. 82 server tests (including the integration tests against the real tool scripts) and 9 store-check tests pass. Test cleanup removes only the entries each test created, one at a time.
