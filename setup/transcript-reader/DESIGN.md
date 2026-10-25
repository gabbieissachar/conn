# Transcript reader - design checkpoint

Status: phase 1 prototype, 2026-10-17. Decisions answered 2026-10-21 (see the end); the overall shape is still being tried on chosen sessions before the real build.

## What was built

A throwaway prototype in `prototype/`: `build_prototype.py` (Python standard library, no model, no network) reads the Claude Code session logs of the main home and every registered second mate, plus each home's fleet records, and fills `template.html`.
Run `python3 setup/transcript-reader/prototype/build_prototype.py` from the repo root, then open `setup/transcript-reader/out/prototype.html`.
The page embeds private transcript text, so `out/` is gitignored. `--stats` prints counts only.

- **Conversation** (view A): one session read back in order, in a 27rem column (phone width). Wake-ups fold to a one-line label, and three or more in a row collapse to one line. Every other turn gets `Needs you` or `No action` from fixed word rules. A `Needs you` reply shows its asking lines first, highlighted. A reply over 90 words shows its first lines and a "Show full reply" button. Buttons and `j`/`k`/`n` jump between your messages and between asks. A Firstmate instruction shows the steering message it delivered, not the pointer line.
- **Fleet timeline** (view B): one time-ordered list across you, the main firstmate, the second mates and their workers. Each row shows who to whom. Phone width has no room for seven swim lanes. The rows are update lines and steering messages from the fleet records, plus your messages and the homes' replies, which only the transcripts have. A row opens its full text and, when found, the turn that handled it. A "Waiting on you" panel comes from each home's own summary.

## What the real data showed

Corpus: 30 home sessions, 2026-09-17 to 2026-10-17, 3,030 turns. Fleet view: the last 72 hours.

- **Folding.** 82% of turns are wake-ups. Folding the ones that ask nothing hides 72% of turns but only 36% of the words. The 12% of wake-ups that do ask (305, mostly after a worker update) hold another 23% of the words.
- **Runs.** Folded wake-ups come in 422 runs: median 2 turns, one run in ten 12 or more, the longest 143.
- **Messages sent while busy.** 75 of your 360 messages (21%) arrived while the agent was mid-turn. They sit inside the running turn, not at a turn start. A parser that splits only at turn starts misses one message in five. The prototype splits there.
- **Rule reliability**, hand-checked blind (labels written before seeing the rule's verdict). The first 40 replies agreed 78%. The misses were negated asks, reminders of open items and promises about later, and the rules were tuned on them. A fresh 40 then agreed 90%: all 20 wake-ups, 16 of 20 replies to you. The 4 errors were 3 false alarms (optional offers, a bold heading phrased as a question, a bold label) and 1 miss (a polite instruction). The heading, label and instruction cases are fixed. Optional offers still count as asks, which errs toward showing too much.
- **Reminders.** 662 replies only restate items already waiting on you. The prototype marks them `No action` with a small "reminds you of open items" tag.
- **Spine.** In 72 hours: 146 update lines (112 routine), 3 steering messages, 23 of your messages, 32 replies. Your messages and the replies exist only in transcripts. Update lines and steering messages exist only in fleet records, and cleanup deletes them when a task closes. Only 25 of 146 update lines could be tied to the turn that handled them. Routine updates often wake nobody, and some landed while no loaded session was running.
- **Open items.** Folding update keys gives 58 decisions never marked settled. 56 of them are older than three days, and many were settled some other way. The homes' own summaries list 49 decisions waiting on you. 12 of the 19 with a recorded age are over a week old, and 5 of 6 homes flag their books as out of step with live state.

## Decisions for the captain

1. **Wake-ups that ask.** Fold every wake-up, or keep the 12% that ask open? Recommended: keep them open. Folding all would have hidden 305 asks in this month of sessions.
2. **Reminders.** Does "still waiting on you" count as `Needs you`? Recommended: no. Mark it `No action` with the reminder tag, and keep the open list in the fleet view.
3. **How much of a kept reply to show.** Recommended: the asking lines first, then the first lines of the reply, with the rest behind "Show full reply" once it passes about 90 words.
4. **Timeline spine.** Recommended: fleet records plus your messages and the homes' replies, with the handling turn one tap away. Raw turns never become the default rows.
5. **Source of "waiting on you".** Recommended: each home's own summary only. Do not derive open items from update keys.
6. **Scope and delivery.** Recommended: the main home and the second mates, not workers' own sessions. Default window of 3 days, with a session picker for older reads. Rebuild with one command, and serve it with the reader's own server (`setup/transcript-reader/serve.sh`, port 8768) so it opens in a browser tab (see README for the supported browsers). No auto-refresh in the first version.

## Answers (2026-10-21)

1. Keep wake-ups that ask open.
2. Reminders are tagged, not `Needs you`.
3. Ask-first-then-clip is the right layout. How asks get picked out (today: the word rules above) is reopened once the app's overall shape is settled.
4. to 6. As recommended.

To try the shape on particular sessions, keep a reading list with `python3 setup/transcript-reader/reader.py` (`add`, `remove`, `list`, `panes`; no argument rebuilds every listed session). A session can be named by id, by its first 8 characters, or by its Herdr pane label. Only listed sessions are read, each under the home that holds its working folder, and the fleet timeline starts at the earliest of them. The session picker shows each session by its Herdr name (pane or tab label, then the pane title), and the address keeps the chosen session across reloads.

## Answer sheet prototype (2026-10-21)

A grill-me review reply asks for keyed answers (`Reply with: A1=...; A2=...`). `prototype/build_questionnaire.py` finds those replies with fixed rules: a card table with `ID` and `Answer` columns (choices in backticks), a `**A2 revised.**` question followed by backtick choice bullets, a checkpoint table of answers already sent, and `**B1:**` cards under a "locked" heading. `questionnaire.html` lets the choices be picked or written, then copies one line such as `A1=accept;A2=inline`. Only a choice the reply itself calls a recommendation is marked one; none is guessed. The reader links each such reply to the sheet. Three layouts were tried (all cards, one at a time, compact); the captain picked all cards, so only that one remains.

Viewing beside a Herdr tab in VS Code: `workbench.browser.newTabPlacement: "sideGroup"` opens VS Code's Integrated Browser (1.142) in a reused, locked group beside the terminal editor. One key can show and hide that group without closing the page or asking for an address: while a browser tab exists (`browserEditorOpen`), it focuses the first group (Herdr) and toggles it maximized, which hides the browser group and keeps its page; with no browser tab it opens the reader. `runCommands` and `workbench.action.browser.open` go in `terminal.integrated.commandsToSkipShell` so the key works while the Herdr terminal has focus.

```json
{ "key": "ctrl+alt+r", "command": "runCommands", "when": "browserEditorOpen",
  "args": { "commands": ["workbench.action.focusFirstEditorGroup", "workbench.action.toggleMaximizeEditorGroup"] } },
{ "key": "ctrl+alt+r", "command": "workbench.action.browser.open", "when": "!browserEditorOpen",
  "args": "http://localhost:8768/setup/transcript-reader/out/prototype.html" }
```

## Send and follow (2026-10-21)

Like Lavish's "comment and send back to the agent", without an agent blocking on a poll: the served page sends a reply or a passage comment straight into the session's Herdr pane (`herdr agent prompt`, no model involved), and follows the pane Herdr has focused. The captain chose:

1. A focused session that is not on the reading list is added automatically.
2. Send goes straight to the pane, with the exact text visible before sending. No confirm step. (For one comment, "Sends exactly" shows it; for a batch, see below.)

The message points at the reply instead of copying it (its time and first words, plus a quote of at most 100 characters for a passage), because the session already holds the text. Sending, following and refreshing need the page served over http by the reader's own server (`setup/transcript-reader/serve.sh`), so `reader.py` now prints the served links first; the server rebuilds the pages when a listed log changes, which replaces the `file://` auto-reload. The pages under `out/` are now served only through the guarded routes in `api.js`, so the shared static handler's wildcard CORS header no longer exposes them. How it works and what it touches: `README.md`.

**Batches and the exact text (owner's decision, 2026-10-26).** Several comments can be collected and sent as one numbered message, with what is in the box last. That message is longer than the box and the pointer line, so it is not shown in full by default: "Exact text" shows it on a click. To keep the preview from going unnoticed, the bar shows a one-line note while the batch is not empty ("3 comments - Exact text shows what Send types"). No confirm step is added, and Send's routing is unchanged. In "Sends exactly", a pointer longer than 90 characters (a reply the session no longer holds adds a log path and part of the reply) shows as one line that opens on a tap, followed by the words as written; the text sent is the same. This matches README.md.

Not verified end to end: no message was sent to a real pane while building this (the tests fake Herdr), and the VS Code shortcut above was not tried in the captain's window.

## Documents, code boxes and cleared sessions (2026-10-21)

The captain asked for three things while trying the prototype:

1. **Documents a reply names**, such as the two markdown files in the eSIM worker's Oct 14 18:25 review reply, rendered for quick browsing beside their contents list, with comments and messages to the agent. The builder finds markdown file names in a reply by fixed rules (`build_prototype.named_documents`) and embeds each existing file once. The Documents tab shows one file at a time beside its headings (a folding list at phone width), and a selected passage or the whole file can be sent to the session as `Re the file <path>, section "<heading>", the part "<passage>": <comment>`.
2. **Code boxes with a Copy button**, as in the Oct 21 13:46 reply that gave `cd` commands. Code wraps instead of scrolling sideways, so a whole command is visible. Tables in replies and documents now render as tables.
3. **Sessions from before `/clear`**. A cleared pane starts a new log, so the earlier turns had disappeared from the reader. A log whose first prompt is `/clear` continues the log last written within two minutes before it (the clear itself writes that log's final records): the one naming the same remote-control link in any project folder, since a session resumed from another directory keeps its old folder while its `/clear` starts the new log under the current one, else the nearest in the same folder. The reader shows such a chain as one conversation under its newest session.

## A more reliable answer sheet (2026-10-21)

The herdr_fix session's Oct 21 13:55 review got no answer sheet: its choices were written `choice: a / b / c` without backticks. Rather than add one more special case, the card reader now works in layers. Every keyed table row, bold question lead or asked-about keyed bullet is a card. Its choices come from the first rule that finds some: backtick values, lettered `a)` choices (also inside the question), a labelled or slash-separated list of short choices, an option table under a "G2 explained" heading, or a short recommendation such as `accept`. The reply line's example answer and any answer it allows for every card (`needs explanation`, `defer`) are added. A card with none of these is still shown and answered by writing one. A choice is marked recommended only when the recommendation opens with it or names its letter. On two weeks of real replies that ask for keyed answers, sheets found went from 27 to 52 and cards from 103 to 225 (201 with choices). The 13 replies still without a sheet are reminders of an earlier sheet or use other key styles (`FX=`, `P, S, Y = confirm`).

The sheet also no longer reloads itself after every rebuild, which had closed "What this is about" mid-read. It takes the new data in place, redraws only when the open questionnaire changed, keeps the scroll position, and remembers which "What this is about" sections are open.


## The hosted copy, ship 1 (2026-10-26)

The owner asked for a hosted transcript reader to browse from anywhere, even with the laptop off, and then to build it, starting with ship 1 of the plan (a split into small objects and a shell page, all on the laptop). How it works and what it looks like: README.md, "The hosted copy".

- **One page, two ways of loading.** The shell is `template.html` built in hosted mode (`build_prototype.fill_template`): no payload, plus `hosted.js`, which loads `index.json` and then one conversation, document or fleet week as the view needs it. Every view is the local page's own code, so the two cannot drift apart; the hosted mode only hides what needs the laptop and paints the "As of" line.
- **The local page's parsing, per conversation.** `sync.py` builds each conversation with the same builder steps the local page uses (`thread_session`, `captain_events`, `mark_sheets`, `attach_documents`, `link_turns`, the parsed-log cache), so an object is exactly that conversation's entry in the local payload. A test builds both from the same sessions and compares them; on the owner's reading list (22 conversations, 190 documents, about 3,000 fleet events) they matched except where a session wrote between the two builds.
- **What a run builds again.** The manifest keeps each conversation's logs with their (mtime, size), the version of the rules that built it (the builder's, the answer sheet's and sync.py's), a stamp of the steering inboxes and task-instruction files it shows, its fleet rows and its turns' times and wake-up tasks. A run builds again only the conversations where one of those changed (a review found that a parser fix otherwise never reached the objects), re-reads a document whose file changed, and puts the fleet weeks together again from the fleet records (cheap: `link_turns` now indexes turns by home and time). An object is written only when its bytes change, and its stamp in `index.json` with it.
- **Choices the plan left open, made here.** The output is `out/hosted/` rather than a separate `out-hosted/`, so the existing ignore rule and the reader server's guard for `out/` cover it. The fleet weeks keep only the first line of your messages and the replies to you, which is all a timeline row shows; the whole turn opens from its conversation. The hosted list counts the replies that need you since your last message ("2 since your last message", so it does not read as the page's own "need you" count of every ask), only while a live pane runs the conversation; a closed pane's conversation says "· closed pane" instead. The page opens on the newest conversation with such a reply. A build older than 10 minutes (the planned sync heartbeat) reads as "Laptop asleep or not syncing". The answer sheet came later the same night (the owner: it would block the agent otherwise): `sheet.html` is `questionnaire.html` in the same hosted mode, loading one conversation's questionnaires (`a/<id>.json`, built by the local sheet's own `chain_questionnaires`) when one is picked.

## The sealed copy, ship 2, local only (2026-10-26)

The owner then said "we can do a local review first, just build it": ship 2 of the plan, all on the laptop. How to run and review it: README.md, "The sealed copy". Nothing is hosted; ship 3 waits on the written exemption or the Replit alternative.

What it is: `sync.py --dry-run` (redact with `redact.py`, seal with `upload.js` and `prototype/seal.js`, prune, heartbeat) into a local folder laid out as the bucket; the same shell opens it after asking for the passphrase. Changes from the plan, and why:

- **No upload code at all.** The plan's ship 2 has an `rclone` upload with a dry-run mode; here the local folder is the only target, so nothing can reach a remote by mistake. Ship 3 adds the R2 target behind the same step.
- **Encryption in Node, through WebCrypto.** Python here has no AES library, and adding one is not this build's call; Node, which the reader's server already needs, has the same WebCrypto the browser uses, so one file (`seal.js`) seals in the sync and opens in the page.
- **Gzip before sealing, and each object's path bound in.** Ciphertext does not compress, so the objects are gzipped first (on the owner's 411 conversations: 44 MB down to 15 MB, the index the phone polls every 30 seconds from 364 KB to 65 KB). The path as additional data stops a host serving one object under another's name. `k/params.json` carries a sealed check word, so a wrong passphrase is told apart before anything else loads.
- **Heartbeat 5 minutes, not 10.** The page calls the laptop asleep after 10 minutes; resealing the index every 5 keeps an idle but awake laptop from flickering to "asleep".
- **A new passphrase needs `--new-passphrase`.** Otherwise a mistyped passphrase would silently seal the whole bucket again and lock out every device that remembers the old key.
- **The LaunchAgent is printed, not installed,** and reads the passphrase from the login keychain at each run, so no file holds it.
- **Synthetic redaction samples.** The plan says tests on real redacted samples; no transcript content goes into fixtures, so every sample secret is made up at run time. On the owner's logs the scan found 133 (130 64-hex tokens, 3 bearer tokens) in 17 objects, counted only.
- Decisions 2 to 6 keep their defaults: records in v1 with a 14-day window and open items always, the derived key remembered on the device with "Forget this device", documents under the home folder as the builder finds them, no Send (Send came after: the next section).

## Send from the hosted copy, local only (2026-10-26)

The owner asked for Send in the hosted copy, so an answer line can reach an agent while the laptop is off ("then need to build it now"): the queue of plan section 8, local only. How it works: README.md, "Send, through a queue". Changes from the plan and what stayed open:

- **The write permission is settled for now, not designed.** The queue write rides the signed-in owner session, and the owner accepted the stolen-session risk for now. At go-live that means whatever lets the page write to the bucket (a presigned upload, or a write-scoped token) is reachable by anyone holding that session, who could then queue prompts for live agents. The drain's own checks (the pane runs that session's Claude, not at a prompt), the 12-hour expiry and one-send-per-id limit it, but do not remove it.
- **The delivery is `api.js`'s own send, not a copy of it.** `create({ sendable })` lets the drain list the conversations of the copy it drains instead of the local reading list, and `sendPrompt` is returned from `create`; every pane check, the clearing of the input box and the single prompt are the local Send's code.
- **A sealed request is sealed by the page.** The reader's server stores `q/<uuid>.json.enc` bytes it cannot open (it checks only the envelope); the path is the additional data, so a request cannot be passed off under another id.
- **The caller says sealed or plain.** A drain that read `k/params.json` to decide would turn a bucket that lost it into a plain copy that takes unsealed requests (a security review caught this); the sync passes `--sealed` for the bucket and `--plain` for `out/hosted/`, and a sealed bucket without its params stops the run.
- **At most once, and no replay.** A "sending" receipt is written before the prompt, and every request that opens and has its shape goes on a record kept on the laptop only (beside the folder, `.drain-handled-v2-<folder>.json`) until it could no longer be fresh, refusals included. Deleting a receipt in the bucket, or putting a copied request back, therefore sends nothing. Freshness is judged on the request's own sealed time (and its time in the folder), never the folder's time alone; a request dated over 10 minutes ahead is refused, so the page's clock matters.
- **A refusal is final.** Nothing retries a prompt that may or may not have reached a pane; the receipt says why and the owner sends again. The page gives up on a request the laptop never picked up after 12 hours and says so.
- **Reply, Comment and the batch are back.** With a message bar the "Copy pointer" stand-ins are gone: the hosted page's Reply, "Comment on this", "Message about this file" and batch are the local page's code, and only Send differs (it queues).
- **Also fixed on the way.** `sync.py` and `upload.js` wrote the copy's folders and files with the default modes; they are now 0700 and 0600 like the reader's own (W23 reached them only after the rebase). The printed LaunchAgent carries a PATH with `node`, `python3` and `herdr` (launchd's own holds none). A changed shell page now reaches the sealed bucket at once instead of at the next heartbeat.
- **Not built, and the open items.** No live check against a real Herdr (every test and lab run uses a fake that records its calls; a live check needs its own isolated lab). The bucket the page writes to is still a local folder: the presigned upload or token, and the drain reading a remote bucket, belong to ship 3.
- **A security review of the whole branch** found nothing exploitable now; what it listed as hardening, for ship 3: the shell pages sit beside the sealed objects, so at go-live whoever can write that storage could swap the shell and take the passphrase (serve the shell from an origin that cannot be written with the data); the passphrase has no strength check (an offline guess at a copied bucket costs 600,000 rounds a try, not more); gzip before sealing leaves sizes visible; and the scanner still lets `Authorization: Basic`, `Cookie:`, Azure `AccountKey=` and a secret inside a doubly escaped JSON string through (Stripe, Google, npm and Hugging Face keys were added; the rest stay open). It also found the sync's passphrase inherited by every `herdr` call it makes (a Herdr that starts its server from one would hand it to every pane's shell): the build's and the drain's Herdr calls now run without it.

