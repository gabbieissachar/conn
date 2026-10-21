# Transcript reader

Reads Firstmate session logs back as a conversation, and lets you answer a reply in its own Herdr pane.
Design and decisions: `DESIGN.md`.

## Run it

```bash
python3 setup/transcript-reader/reader.py add <session id, 8-char prefix, or Herdr pane label>
python3 setup/transcript-reader/reader.py          # rebuild every listed session, start the server, print the links
```

`reader.py` also has `remove`, `list` and `panes` (live Herdr panes to pick from).
Set `PMOS_SERVE_PORT` when the default port 8765 serves another copy of the repo.
After changing `api.js` or `setup/serve.sh`, restart the server: `bash setup/serve.sh --restart`.

Open the printed `http://localhost:…/setup/transcript-reader/out/prototype.html` link, in a browser or a VS Code browser tab.
Opened that way, the page:

- **Refreshes itself.** When a listed session writes a new turn, the server rebuilds the pages (at most every 3 seconds, only while a page is open) and the page swaps in the new turns where you are reading. When the page's own code changes it reloads, keeping the replies you expanded and your place.
- **Follows Herdr.** With "Follow Herdr" on, the reader shows the session of the pane Herdr has focused. A session not on the reading list is added. An address that names a session (`#s=…`) wins when the page opens.
- **Sends replies.** "Reply" on a reply, or "Comment on this" after selecting a passage in it, opens a composer. "Send" puts the exact text shown under "Sends exactly" into that session's Herdr pane. It points at the reply instead of copying it, for example `Re your reply at 10:57 ("Checkpoint for group A"): A2=link-only`. The answer sheet's Send does the same with the picked answers.

A `file://` copy of the page still reads, but cannot refresh, follow or send.

In any copy of the page:

- **Documents.** A markdown file a reply names (`requirements.md`, `02-Projects/x/work-log.md`, an absolute or `~` path) opens from a button under that reply, in the Documents tab: the file rendered beside its contents list (one column with a folding list at phone width). Select a passage and "Comment on this", or use "Message about this file", to send a message naming the file, its section and the passage. A relative name is looked up under the latest `cd` directory the reply gave before it, then under the turn's working directory and its parents below your home folder. Files over 512 KB are skipped. The page shows each file as it was at the last rebuild.
- **Code boxes.** Fenced code (commands, snippets) shows in a wrapped box with a Copy button that copies exactly the code. Tables render as tables.
- **Collapsible header.** The chevron at the top right folds the tabs and controls into one line naming the session, document or view. Tap that line or the chevron to bring them back. The choice is kept in this browser.
- **Cleared sessions.** `/clear` starts a new session log in the same pane. The reader joins the sessions a pane ran into one conversation, under the newest one, with a divider at each clear: the log written in the same folder within two minutes before the `/clear` is the one it cleared. Naming any of them (`#s=…`, `reader.py add`) opens the whole conversation, and `reader.py` adds the newest one to the reading list. Replying to a turn from before a clear goes to the pane's current session, and the message names the earlier log, since that session never saw the turn.

## What it touches

- Reads Claude Code session logs, the fleet homes' records, Herdr's session list and snapshots, and the markdown files replies name.
- Writes only `out/` (gitignored: the pages embed private transcripts).
- Sends a prompt to one Herdr pane, only on a Send click, and only to the one live pane whose agent runs that listed session. It refuses an agent waiting at a permission prompt. It never starts, stops or closes a Herdr session, tab or pane, and never addresses the default Herdr session.

The server routes are in `api.js`: the pages under `out/` and `/api/transcript-reader/*` use the Herdr organizer's guard (exact Host and Origin, Fetch-Metadata, a per-start token) and send no CORS header, so another website cannot read the transcripts or send a prompt.
Other apps served on the same port share the page's origin, so no endpoint hands out the token.
The server writes it into a page only when a browser tab opens that page, and the page refuses frames and cuts off whoever opened it, so a script in another app on that port cannot read the transcripts or send a prompt either.
A restarted server has a new token: an open page reloads itself once to pick it up (not while you are typing).
A path that the file system resolves into `out/` (another letter case, Unicode form or a symlink) is answered by `api.js` too, never by the shared static handler.

## Tests

```bash
python3 -m unittest setup/transcript-reader/test_questionnaire.py setup/transcript-reader/test_reader.py
node --test setup/transcript-reader/api.test.js
```
