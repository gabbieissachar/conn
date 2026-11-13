# Herdr Agent Session Replay

Use this when `herdr` already manages layout and pane transport, but pmOS still
needs a replay contract for resumable Codex and Claude sessions.

## Model

- `herdr` owns named-session persistence, workspaces, tabs, panes, and
  worktrees.
- pmOS keeps a narrow replay registry keyed by the compound identity
  `herdr_session + pane_id`; pane IDs are only unique inside one named Herdr
  session.
- `herdr-agent-register` records `pane_id -> client -> session_id -> cwd ->
  resume_command`.
- `herdr-agent-scan` and `herdr-agent-autoregister` enumerate live herdr panes,
  auto-register panes whose resume ids are visible in scrollback or in the
  foreground process command, and park the rest in missing-session JSON.
- `herdr-agent-verify-identity` is the read-only verifier for live supported
  panes. It accepts only independently agreeing, store-backed evidence.
- `herdr-agent-capture-history` runs the verifier without pane input, then
  preserves the legacy scrollback and process scan with its compatible flags.
- The scan checks Herdr's pane-level native `agent_session` metadata first when
  an official integration has reported it.
- `herdr-agent-capture-status` opt-in queries `/status` in unresolved idle or
  done agent panes and parses the returned session ID; it does not query
  working or blocked panes.
- `herdr-agent-restore` safely replays `codex-r` or `claude-r` into registered
  panes.
- `herdr-agent-recover` runs the post-restart sidecar recovery sequence in one
  command: history scan, opt-in status capture, then replay.
- `herdr-agent-capture-missing` preserves the tmux-era manual repair pattern
  when a pane is known but the resumable session id is not.

A Claude pane may run under a second account's config folder (`CLAUDE_CONFIG_DIR`, for
example `~/.claude-personal`) instead of `~/.claude`, and Herdr does not say which.
`claude_config_dirs.py` is the one place that finds the folders (the process's own,
`~/.claude`, and each other `~/.claude*` folder that holds `projects/`), the folder a
session's log or a process's pid record is in, and the resume command. The identity
verifier, the registry and the organizer all use it, so a pane's session is found in the
folder it really uses. A session that lives outside `~/.claude` is recorded with a
`config_dir` field, and its resume command names the folder
(`CLAUDE_CONFIG_DIR=<folder> claude --resume <id>`), so a restore resumes it under the
same account. A record of the default account has no `config_dir` and the plain command.

State files default to:

```sh
/Users/nguyen.tran/workspace/conn/setup/herdr/state/
```

The registry creates this sidecar directory with mode `0700`, and keeps its
manifests, missing-session JSON, status log, and lock files at mode `0600`.
Existing permissive state files are tightened before use. Explicit file
overrides require an existing non-symlink parent already set to `0700`; the
override parent is never created or chmodded by the tools.

## Shell Setup

Source these in shells that launch or resume Codex or Claude inside herdr:

```sh
source /Users/nguyen.tran/workspace/pmos/setup/codex-shortcuts.zsh
source /Users/nguyen.tran/workspace/conn/setup/herdr/agent-session-shortcuts.zsh
```

## Core Commands

Register a known resumable session for the current pane:

```sh
herdr-agent-register codex <session_id>
herdr-agent-register claude <session_id>
```

To register a different pane (for example from outside Herdr), pass all three of
`--pane-id`, `--workspace-id` and `--tab-id`, plus `--herdr-session`. Explicit ids
are used as given and the pane Herdr calls current is never consulted; giving only
some of the three is an error. `herdr-agent-capture-missing` follows the same rule.

List registered replay targets. The first column is the Herdr session:

```sh
herdr-agent-list
```

Session IDs are redacted from the normal listing. Use
`herdr-agent-list --show-session-ids` only when manual repair requires them.

Normalize the manifest field order after manual edits or migrations:

```sh
python3 /Users/nguyen.tran/workspace/conn/setup/herdr/agent-session-registry.py normalize
```

Legacy evidence scan and explicit status capture:

```sh
herdr-agent-scan
herdr-agent-autoregister
herdr-agent-capture-status
```

The status capture is opt-in because it sends a diagnostic command into idle or
done agent panes. It registers only panes whose response contains a session ID.

## Verified Identity Workflow

Run the verifier against one explicitly named, running, non-default session:

```sh
herdr-agent-verify-identity --herdr-session esim
```

The default is report-only. It prints one redacted row per supported pane with
its workspace and tab labels, stable pane ID, a classification, candidate
count, and evidence categories. It prints no client session IDs, private store
paths, resume commands, or transcript text. Use `--show-session-ids` only for
an explicit manual repair review. Use `--diagnostic-session-paths` only when
socket-path diagnostics are explicitly required.

Apply only rows that pass the verifier's acceptance rule:

```sh
herdr-agent-verify-identity --herdr-session esim --apply
```

The verifier accepts a live idle or done supported pane only when the current
foreground process, one exact client session ID, client store header, pane CWD,
and current process identity agree. A current process-start marker is required
when the platform exposes one. A native hook value must be a real client store
ID, not a `herdr:*` display value. Conflicts, zero or multiple open handles,
and multiple sessions sharing a CWD remain `unresolved` or `candidate_ambiguous`.
The apply path re-reads the live pane immediately before each private manifest
write and discards changed PID, CWD, client, or process-start observations.

The verifier never chooses the newest file, nearest mtime, first rollout, or a
CWD-only candidate. It does not broaden the existing narrow Codex interactive
picker matcher. Rows that remain ambiguous require manual confirmation. The
existing `/status` capture remains a separate, explicit, idle-or-done-only last
resort and sends input into the pane.

`herdr-agent-capture-history` sees only the Herdr session attached to its
shell. Running it in a plain terminal can therefore find no panes even while a
named session is running. Use `herdr session list --json` to find a running
session's name and socket path, then use the concrete shell-quoted command the
scan prints for that session. The default Herdr session is not supported for
recovery.

Or run the command inside an existing pane of that named session.

This tries to detect `session_id` values from pane scrollback, keeps already
registered panes, and writes unresolved panes into the missing-session JSON for
manual fill.

Preview replay:

```sh
herdr-agent-restore
```

Execute replay:

```sh
herdr-agent-restore --execute
herdr-agent-restore --execute --all
herdr-agent-restore --pane-id w3:p1 --execute
```

Normal restore previews redact resume commands. Use
`--show-resume-commands` only when you explicitly need to inspect one.

## Restart Recovery

Herdr persists each named session's workspaces, tabs, pane layout, labels, and
cwd. It cannot keep arbitrary foreground processes alive across a computer
restart, so agent conversation restoration is a separate layer for every
selected named session.

Preferred path, after verifying it on one non-critical pane:

```sh
herdr integration install codex
herdr integration install claude
herdr integration status
```

Herdr's native integrations report the agent session references and let Herdr
restore them with the layout. Repair and verify those integrations before
relying on new native reports. Keep native agent restore enabled in Herdr
configuration. The verifier remains the safe fallback for panes that lack
current native metadata.

Current sidecar fallback after Herdr is running again. Attach each selected
non-default named session in its own terminal, because each attach exposes a
different Herdr pane namespace:

```sh
herdr session attach esim
herdr session attach Misc
herdr-agent-recover
```

Run `herdr-agent-recover` once per attached named session. It scans and restores
only the session exposed by the current `HERDR_SESSION`/Herdr socket, so a
`w1:p1` in `esim` cannot collide with a `w1:p1` in `Misc`.

The recommended order is: repair integrations, run the verifier report, apply
only verified rows, then run restart-recovery preflight. Use `/status` only as
the final explicit step for unresolved idle or done panes. Its diagnostics are
appended to:

```sh
setup/herdr/state/herdr-agent-status-capture.jsonl
```

The JSONL file records outcomes and identifiers, not pane output. A login hook
or LaunchAgent can later run the attach and recovery sequence automatically;
that should be added only after the interactive flow is proven.

Remove one registration:

```sh
herdr-agent-remove w3:p1
```

## Manual Missing-Session Flow

Capture one editable repair row for the current pane:

```sh
herdr-agent-capture-missing --client codex
```

This writes:

```sh
/Users/nguyen.tran/workspace/conn/setup/herdr/state/herdr-agent-missing-sessions.json
```

Fill `session_id`, then apply it:

```sh
herdr-agent-apply-missing
```

## Current Scope

This v1 intentionally does not port tmux layout restore, tmux snapshot listing,
or tmux pane scanning. Herdr already owns layout persistence and native agent
resume. It can move individual panes between workspaces, but it cannot move a
complete tab atomically or archive a workspace non-destructively. Those gaps
belong in Herdr rather than this sidecar.

## Restart-Recovery Bundles

`prepare-restart-recovery` is separate from `archive`. It does not close a
workspace or tab, send a status command to a busy pane, or dispatch an agent
resume command. `backup-all` is an alias for the same non-destructive command.

Use this safe order when a computer restart could interrupt Herdr:

1. Attach the exact named sessions that need recovery, then run a strict
   preflight and seal the bundle. Repeat `--session`; without it, the command
   selects only sessions running at preflight time. It never selects every
   saved session directory. The default Herdr session is not supported here.
   When it is running, name every non-default recovery session explicitly.
2. Restart only after the command reports that the bundle is `ready`.
3. After boot, attach each bundled session through Herdr's normal interactive
   path. Recovery does not start sessions for you.
4. Run the reconciliation preview. It adopts matching native workspaces and
   identifies only proven-missing workspaces for rebuilding.
5. Confirm the preview, then check the recorded verification result. Agent
   command dispatch and observed agent recovery are reported separately.

For example:

```sh
herdr-organizer prepare-restart-recovery --session project-a --session project-b
# Keep the printed bundle ID private and local.

# Restart the computer, then attach each selected session in the normal Herdr UI.
herdr-organizer reconcile-all --bundle <bundle_id>
herdr-organizer reconcile-all --bundle <bundle_id> --confirm <bundle_id>
```

The preparation preflight refuses a session without exactly one focused
workspace, busy or unresolved Codex and Claude panes, missing CWDs or
registered worktrees, unknown foreground process state, and unclassified
non-shell processes. A supported agent with `idle` or `done` status and a
verified recovery identity is safe to resume. To acknowledge one intentionally
volatile process, name its complete identity. There is no global bypass:

```sh
herdr-organizer prepare-restart-recovery --session project-a \
  --allow-volatile-pane 'project-a|w3|w3:t2|w3:p1'
```

When preflight fails, its default output groups every failure by kind and prints
the named `session|workspace|tab|pane` identity with the current workspace and
tab labels when available. It prints no cwd, process command line, agent-session
ID, resume command, or scrollback. A `blocker` entry includes the exact
copy-pasteable `--allow-volatile-pane` value, but only use it for a process you
intentionally accept as volatile. A supported Codex or Claude pane must have
`idle` or `done` status and verified recovery identity. A working or blocked
pane reports the status remedy. An idle or done pane without a verified
identity reports the capture remedy: run `herdr-agent-capture-history` for the
named session, or `herdr-agent-capture-status` for that pane, then retry. Do
not acknowledge a busy, unresolved, or unknown agent state.

If a workspace has no workspace CWD and its panes use different existing CWDs,
preflight fails by default. You may acknowledge only that named workspace:

```sh
herdr-organizer prepare-restart-recovery --session project-a \
  --allow-mixed-cwd-workspace 'project-a|w3'
```

If that workspace must be rebuilt, Herdr uses the first pane's CWD in layout
order. Every pane CWD must still exist. Native adoption is unaffected. A
rebuilt acknowledged workspace reports that `layout.apply` could not restore
per-pane CWDs.

Acknowledgements are pipe-delimited. Restart recovery rejects a pipe in a
session, workspace, tab, or pane identity before printing an unusable command.

Bundles, per-session captures, checksums, and reconciliation journals live in
`state/workspace-organizer/restart-recovery/`. They are local-only, gitignored,
and created with private permissions. They contain paths and supported-agent
resume metadata, so do not commit, upload, or share them. Keep the pre-boot
bundle and post-boot journal until you accept the result, then delete them
manually under your normal local retention policy. The tool never silently
prunes them.

`reconcile-all` is preview-first. It refuses an unattached bundle session and
never starts one. It does not rebuild an ambiguous native match. An intentional
additional copy requires both `--copy-ambiguous` and the second confirmation
`--confirm-extra copy:<bundle_id>`. `rollback-reconcile` also starts as a
preview and can close only workspace IDs created by that bundle's journal. It
never closes adopted native workspaces. Both previews are read-only and do not
create a journal directory or lock file. A confirmed rebuild restores the
captured active workspace after all layouts exist. A confirmed rollback records
each workspace close before it happens and only marks it closed after a
snapshot confirms that workspace ID is absent. An interrupted rollback can
then resume without touching a workspace that was already closed.

During a confirmed rebuild, the organizer gives each newly created workspace
and tab a durable private-operation suffix such as `[rrb:…]`. The journal
records that marker before the mutation. A retry or rollback acts only when
the marker, expected CWD, label, and layout shape all match. It never claims a
workspace or tab only because it appeared after an interrupted request. If
Herdr does not retain a marker, recovery stops for manual repair. The marker
remains in the label until the recovery is accepted so that ownership stays
auditable.

## Workspace Organizer MVP

`herdr-organizer` is a local bridge for the immediate workflow. It reorders
tabs within their current workspace without disrupting processes. It can also
archive a whole workspace by saving its tab layouts and supported agent resume
references, then closing the workspace. Restore creates a new workspace and
fresh shells from that archive.

It does not preserve running processes, terminal scrollback, or an atomic
cross-workspace tab move. An archive with working or blocked agents is refused
unless you explicitly acknowledge that those processes will stop.

Write the snapshot consumed by the local viewer:

```sh
herdr-organizer snapshot
herdr-organizer-ui
```

When only one named Herdr server is running, the organizer selects it
automatically. When more than one is running, choose the target explicitly:

```sh
herdr-organizer-ui --session esim
```

Preview an archive, then execute it with the exact workspace ID:

```sh
herdr-organizer archive --workspace w3
herdr-organizer archive --workspace w3 --execute --confirm w3
```

Restore an archive as fresh shells. A restore without `--resume-agents` only
rebuilds the layout: the archive stays `archived`, keeps its restore commands,
and records the workspace it opened (`layout_restore`). Only a restore with
`--resume-agents` sends supported Codex or Claude resume commands and marks the
archive `restored` (or `resumed`). When that earlier layout copy is still open
and is exactly what the restore built, `--resume-agents` resumes the agents inside
it instead of making another workspace. Exactly means the same tabs, the same
layout shape as the capture and the same pane ids the restore recorded, so a
replaced, swapped or rearranged pane is never adopted, even when the counts
still match. A copy from an interrupted restore, and one recorded before pane ids
were kept, is judged on what exists: an interrupted copy has no record to compare
and is not reused, and an older record adopts on the layout shape alone. It never
types a resume command into a pane that already shows an agent. A second layout-only restore of an archive
that already has an open copy does nothing, and `--force` is the only way to a
second copy:

```sh
herdr-organizer list-archives
herdr-organizer restore --archive <archive_id>
herdr-organizer restore --archive <archive_id> --execute --confirm <archive_id>
herdr-organizer restore --archive <archive_id> --resume-agents --execute --confirm <archive_id>
```

Archive every live workspace at once with `archive-all`. It applies the same
guards as `archive` to each workspace: a workspace with a working or blocked
agent, or an agent without a verified resumable session, is skipped and
reported with the reason. The allow flags are deliberately not offered, so run
`archive` on a skipped workspace if you want to override. Every archive the run
joins the session's one archive group (a `batch_id`; the first run creates it). A
manifest in `state/workspace-organizer/batches/` lists the archived members, and
the workspaces the latest run skipped (never session ids). A session has one
group for good: a later run adds to it, a workspace that is restored or whose
archive is deleted leaves it, and a workspace archived again becomes one new
entry. A workspace whose open layout copy is still a member replaces that
member (the older archive stays as a single archive). Groups made by earlier
runs are merged into the session's oldest group the first time a locking command
runs. Confirm with the session name. It refuses to run, before closing anything,
from inside a workspace it would archive, so run it from a terminal outside Herdr.

```sh
herdr-organizer --session esim archive-all
herdr-organizer --session esim archive-all --execute --confirm esim
```

Before restarting the computer, `archive-all --snapshot` saves every workspace
into the same group without closing anything. A working or blocked agent is
included too (the restart stops it anyway; it resumes from its saved session),
and an agent without a verified session still skips its workspace. Snapshot
members are flagged, and a newer snapshot or a closing archive of the same
workspace replaces the older snapshot. The same workspace means the same id and
either the same label or a shared agent session, so renaming a workspace between
two snapshots leaves one member; a reused id with another label and other
sessions is a different workspace and keeps its own member. After the
restart Herdr may bring workspaces back by itself. Restoring a snapshot member
first looks for one open workspace with its label and a live twin of every
captured tab (same label, same layout shape): that workspace is adopted, only
panes without an agent get a resume command, and sessions already running are
skipped. A workspace that is only partly back (or more than one look-alike) is
left alone with the reason, never rebuilt on top; `--force` still makes another
copy. `restore-batch --snapshot-only` restores just the snapshot members and
leaves the group's ordinary archives alone. If a group still holds two snapshots of
one renamed workspace (made before the rename was recognised), the run restores only the
newer one, and it never resumes a session a member of the same run already resumed, so no
agent session runs twice. `restore-tab` and `restore-tabs` adopt an
already-open tab of a snapshot member the same way. Leader tabs keep their rule:
a natively restored one is adopted, never duplicated.

A snapshot restore leaves no snapshot member `archived`, because the group shows its
snapshot restore button while one is. Each member ends restored or resumed (and leaves
the group), or, when it cannot be finished (a workspace only partly back, a leader tab
already open, a refused resume), `restore_partial` with the reason in its `restore.left_alone`
(or `error`); it stays in the group with its saved layout and agent identities, and
`restore <archive> --resume-agents` retries it. An older member whose agent sessions a newer,
restored member holds leaves the group and stays as a single archive. A run with
`--resume-agents` then deletes the finished snapshot records of the group (restored or
resumed, restore completed without error): their workspaces are running, so nothing is
left in them to restore. Archives that are still archived or `restore_partial`, ordinary
archives, and other groups are never touched. A new snapshot retires finished snapshot
records the same way and replaces a member a restore left alone like an archived one. The
preview lists each snapshot member's forecast (`adopt`, `left_alone`, `build_new_workspace`)
and the records it would retire, and changes nothing.

A live tab only counts as a captured tab's twin if the evidence agrees. A label
and a layout shape are not enough (Herdr's default tab label is `1`): every pane
must be in the folder of the captured pane, and every pane that would be typed a
resume command must be at a plain shell prompt, so an editor or a dev server
never gets the text. A folder missing on either side cannot be compared and
counts as no evidence. A pane that already runs the captured session is the
captured pane whatever folder it is in now (an agent moves into its worktree after
the capture), and nothing is typed into it. No pane of it may run an agent other than
the captured session either; a fresh agent Herdr relaunched there, or another session,
also fails. A whole workspace with such a tab is left alone and the output says why
("open, but its pane w9:p1 is in another folder than the captured pane"), and
`restore-tab` prints the same reason and rebuilds that tab instead of adopting the
open one. Pairing runs over all of the archive's
tabs, so a live tab that belongs to a tab left behind is never taken for a
selected one. Restoring a snapshot member while everything is still open
adopts it and consumes it, as any restore does, so do not run `restore-batch`
before the restart.

```sh
herdr-organizer --session esim archive-all --snapshot
herdr-organizer --session esim archive-all --snapshot --execute --confirm esim
```

Restore a whole group with `restore-batch` (`--batch` defaults to the group of
`--session`). It acts only on members that are still `archived`; a member leaves
the group once it is restored. Without `--resume-agents` it lays out each member that has no
open layout copy and marks nothing restored, so every restore command stays.
With `--resume-agents` it resumes each member in its open layout copy, or in a
new workspace when there is none. Members left `restore_partial` or not
closed are reported and left alone, and `--force` is
never used. It refuses a session other than the one the batch was captured
from, and keeps going after one member fails, then exits non-zero. Confirm
with the batch ID.

```sh
herdr-organizer list-batches
herdr-organizer --session esim restore-batch --batch <batch_id>
herdr-organizer --session esim restore-batch --batch <batch_id> --resume-agents --execute --confirm <batch_id>
herdr-organizer delete-batch --batch <batch_id> --execute --confirm <batch_id>
```

Commands that create, restore, move or delete archives, or close tabs, share one lock while they execute
(`archive`, `archive-all`, `archive-tabs`, `restore`, `restore-batch`, `restore-tab`, `restore-tabs`,
`delete-archive`, `delete-archived-tab`, `delete-batch --archives`, `move-tabs`, `resume-move`,
`cleanup-empty-tabs`, `add-tabs-to-batch`, `finish-tab-add`, `handoff-restart --execute`), so a second run is refused instead of overwriting the first. Previews, `snapshot`,
`list-archives`, `list-batches` and `reorder-tab` do not lock. `delete-batch` and the group commands lock when they execute.

### Handoff and restart (other Claude panes)

`handoff-restart` asks chosen Claude panes to save a handoff, then restarts each session with `/clear` and tells it to read
the handoff. It is a preview unless `--execute --confirm` is given, and it runs from a terminal, never from a page.

```sh
herdr-organizer --session esim handoff-restart --pane w1:p2:0b407c12
herdr-organizer --session esim handoff-restart --pane w1:p2:0b407c12 --execute --confirm handoff-restart:esim:0b407c12
```

A pane is `<pane id>:<first 8 characters of its session id>`. The preview names the exact confirm string (the ids sorted)
and refuses, with a reason, every pane that is not an idle, unfocused Claude pane with an empty input box. Panes that
belong to firstmate (worker or primary records, firstmate home folders, leader and task workspaces, `fm-` and `leader-`
tabs, and sessions the context gauge of any home maps to a worker) are always refused: they restart through firstmate's
own rollover.

Each pane then runs five gated steps, re-reading the pane before each one: ask for the handoff (`/handoff ...`), check
the document named on the last line of the reply (read from the session transcript, never from the screen), a quiet
check, `/clear` typed once and submitted with Enter, and a resume message sent only to the pane whose session id changed.
Nothing typed is ever typed twice, a pane that stops is reported and left alone, and a pane that stopped after `/clear`
was typed gets a printed line telling you how to resume it by hand. Up to four panes run at once under the same lock as
`archive-all`. The run record is `state/workspace-organizer/handoff-runs/<run id>.json` (0600, no transcript text, no
full session id). Exit code 0 means every pane reached the resume message.

If the context gauge of a firstmate home fails, `--execute` refuses (`fleet_gauge_incomplete`); `--skip-fleet-gauge` goes
on and the run record says so. `--fleet-home <path>[=<code root>]` adds a home the usual folders do not reach.

### Firstmate worker records

A worker that a firstmate or secondmate home spawned is bound to its Herdr pane by that home's `state/<task>.meta`
(`window`, `herdr_workspace_id`, `herdr_tab_id`, `herdr_pane_id`). Archiving closes the pane and a restore, a move or a
reboot rebuilds the tab under new ids, so the record goes stale: the home then reads the live worker as gone, cannot
steer it and may start a duplicate. Every executing command that closes or rebuilds tabs therefore checks the records
of its session in every home under `~/.treehouse/firstmate-*/*/firstmate/state` and `~/fm-homes/*/state`
(`HERDR_ORGANIZER_OWNER_STATE_DIRS`, a path list, replaces those):

- A record whose pane is gone and whose worker is found again is rewritten, all four fields together, to the new
  pane. The worker is found by the pane the command itself rebuilt, or else by the one live tab labelled `fm-<task>`
  (with one pane, or exactly one agent pane). The new tab's label must match `fm-<task>` or the label the home
  recorded, and for a secondmate record the bare task id too (any other bare id, such as `notes`, is a name anyone may
  give a tab); otherwise nothing is written and a warning says why. The old record is kept beside it as
  `<task>.meta.herdr-relink-<time>-<id>.bak`, the write is atomic and it is refused if the record changed meanwhile.
  The home's `<task>.herdr-presentation` ids follow when they matched the old pane.
- A record is only pointed at a pane that no record in any home already names, so two homes never own one worker.
  When the only match is such a pane, or two stale records want the same pane, the records are left alone and the
  warning names the other record.
- An executing command looks only at the records it touched: those whose pane it closed or rebuilt. A record that
  was already stale before it ran is left for `relink-owner-records`, and a command that changed no pane, such as one
  refused for a wrong `--confirm`, touches no record.
- A record whose pane this command closed, with no live tab carrying the label, gets a `<task>.herdr-archived` marker
  (task, old ids, tab label, time) so the home can tell an archived worker from a dead one. The marker is removed when
  the worker comes back. The record itself keeps its ids.
- A `fm-*` or `secondmate-*` tab that closed or was rebuilt without any home's record pointing at it, no home
  directory found, or a record that could not be written is reported as a `WARNING` on stderr. The command's own result
  does not change.

`relink-owner-records` runs the same check on its own, for a reboot or a restore done before this existed. Without
`--execute` it only lists what would change; the rewrite needs `--execute --confirm <session>`.

```sh
herdr-organizer --session esim relink-owner-records
herdr-organizer --session esim relink-owner-records --execute --confirm esim
```

The marker is written for the homes to read; the firstmate scripts that would act on it (`fm-crew-state`, `fm-send`,
`fm-control`) are separate work in that repository. Append-only logs, `*.control-relaunch` records and
`home-summary.json` also mention pane ids and are left alone.

Add selected live tabs to the session's archive group with `add-tabs-to-batch`
(`--batch` defaults to the group of `--session`). A session with no group yet gets one from the first add; that run is confirmed with the session name, since the group id is only chosen when it executes. It captures
the tabs, then closes them and stops their processes. Tabs from one live
workspace become one new batch member labelled `<workspace> (selected tabs)`. A tab
whose live workspace is already tied to a member of that batch merges into that
member instead. The match uses exact recorded workspace ids only: the member's
restored workspace, its open layout workspace or its original workspace, never
the label. A merged member goes back to `archived`, its old `restore` and
`layout_restore` records move to `restore_history` so nothing adopts them, and a
selected tab that an earlier restore rebuilt replaces its captured original in
place. Captured tabs you did not select stay in the archive, so the next restore
rebuilds them even if they are still open in the earlier workspace, and agents
already resumed there resume again. The preview warns when that applies.

Right before anything closes, the command reads the live session again. If a
selected tab gained a pane, a working agent or a different layout, or the
workspace it would close gained a tab, it closes nothing and undoes the whole
addition (the new archive is removed, a merged member returns to exactly what it
was). A tab that already closed by itself is skipped. Each tab's close is
recorded, and a close that fails or is interrupted leaves the archive
`close_failed` with the still-open tab ids, outside `restore` and `restore-batch`.
Finish it with `finish-tab-add`, which checks the still-open tabs again, refuses
if they changed, closes only the ones still open, and makes the archive
`archived` and restorable:

```sh
herdr-organizer --session esim finish-tab-add --archive <archive_id>
herdr-organizer --session esim finish-tab-add --archive <archive_id> --execute --confirm <archive_id>
```

Selecting every tab of a workspace archives it whole and closes the workspace. The
workspace the command runs inside, and the only workspace left in the session,
keep one tab open. Any other selected tab the command runs inside is refused. The
batch must be finished (`completed` or `completed_with_failures`) and from the
session you pass. Working or blocked agents and agents without a verified
resumable session are refused, with no override. Confirm with the batch ID.

```sh
herdr-organizer --session esim add-tabs-to-batch --batch <batch_id> --tab w3:t2 --tab w3:t4
herdr-organizer --session esim add-tabs-to-batch --batch <batch_id> --tab w3:t2 --execute --confirm <batch_id>
```

`delete-batch` removes only the group record. Its archives stay as single archives.
Add `--archives` to also permanently delete every archive that belongs to the batch
(an archive is only deleted when its own `batch_id` matches). The preview lists what
would go and warns when members are still archived, because their saved layouts and
agent identities would be lost. The record is kept if any archive cannot be deleted.
Live and restored workspaces are never touched. It needs its own confirmation value,
`delete-archives:<batch_id>`, so the record-only confirmation cannot authorize it.

```sh
herdr-organizer delete-batch --batch <batch_id> --archives
herdr-organizer delete-batch --batch <batch_id> --archives --execute --confirm delete-archives:<batch_id>
```

Close empty shell tabs in a workspace with `cleanup-empty-tabs`. A tab with an
agent, a resumable session or a running process is never touched. When every tab
of a workspace is an empty shell, the workspace closes with its last tab. It looks
again right before closing, and closes nothing if the workspace gained a tab or a
tab stopped being an empty shell since the preview. The
one exception keeps its last tab: the workspace the command runs inside, and the
only workspace left in the session. The preview reports `close_workspace` and
`kept_reason`:

```sh
herdr-organizer cleanup-empty-tabs --workspace w3
herdr-organizer cleanup-empty-tabs --workspace w3 --execute --confirm w3
```

Reorder a tab with a zero-based destination index:

```sh
herdr-organizer reorder-tab --tab w3:t2 --index 0
herdr-organizer reorder-tab --tab w3:t2 --index 0 --execute
```

Move selected tabs to another workspace with the organizer's multi-select UI,
or repeat `--tab` in the terminal. This is an archive-stop style operation: it
rebuilds layouts in the destination and only then closes the original tabs.
It does not preserve their running processes, but it automatically sends
supported Codex and Claude resume commands into the replacement panes. It
writes a recovery record before it closes any source tab, so a failed resume
can be retried.

```sh
herdr-organizer move-tabs --tab w3:t2 --tab w3:t4 --to-workspace w5
herdr-organizer move-tabs --tab w3:t2 --tab w3:t4 --to-workspace w5 --execute --confirm w5
herdr-organizer resume-move --move <move_id> --execute --confirm <move_id>
```
