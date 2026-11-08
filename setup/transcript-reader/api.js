'use strict';

// HTTP surface for the transcript reader. server.js (the reader's own server) hands
// every request to this module.
//
//   GET  /setup/transcript-reader/out/<page>.html  the built pages, opened in a browser tab
//                                                   only; each carries the per-start token
//   GET  /setup/transcript-reader/out/hosted/index.html
//                                                   the hosted copy's shell (sync.py), the same way
//   GET  /setup/transcript-reader/out/{hosted,bucket}/{sw.js,manifest.webmanifest,icon-*.png}
//                                                   the offline copy's service worker, web app manifest and icons
//                                                   (no transcript), for the shell that installs them
//   GET  /setup/transcript-reader/out/hosted/{index.json,s/*,d/*,f/*,a/*,t/*,r/*}
//                                                   the objects that shell loads (r/ holds the receipts of
//                                                   its queued sends), to its own token-bearing fetches only
//   GET  /setup/transcript-reader/out/bucket/...    the sealed copy (sync.py --seal):
//                                                   its shell, k/params.json and the
//                                                   *.enc objects, the same ways
//   GET  /setup/transcript-reader/out/live/index.html
//                                                   the lite page: the reader page's code in mode "live", which opens one conversation
//                                                   (#s=<id>) and loads only that one, from the objects below; served and token-filled like
//                                                   any page, and live like the local page (state poll, events wait, Follow, Send)
//   GET  /setup/transcript-reader/out/live/sheet.html
//                                                   the lite page's answer sheet: the sheet's page in mode "live", which shows the sheet of the
//                                                   conversation it is opened on (#q=<session>:<time> or #s=<id>), sends straight to the pane
//                                                   as the local sheet does, and links back to the conversation; served like any page
//   GET  /setup/transcript-reader/out/live/embed.html
//                                                   the embed page: the reader page's code in mode "embed", which a host's web view (Conn's, for
//                                                   a ShopBack Campus conversation) loads and feeds with one conversation's turns as JSON through
//                                                   window.readerEmbed. It holds no transcript, carries no token, allows no connection and keeps
//                                                   nothing; served like any page, and never calls this server back
//   GET  /setup/transcript-reader/out/live/{index.json,s/*,a/*}
//                                                   the objects every build writes for them (build_prototype.write_live): the index of the
//                                                   listed conversations, one conversation's entry (s/) and one conversation's answer sheet
//                                                   (a/), to their own token-bearing fetches only. Read from files: nothing here parses the
//                                                   34 MB page or asks the worker.
//   GET  /api/transcript-reader/page?name=<page>    the built page again, for a page's own refresh
//   GET  /api/transcript-reader/state[?follow=1][&boot=1]  page build stamps, the session Herdr
//                                                   has focused, the listed sessions' live panes. boot=1, which a page sends
//                                                   with its first call only, may be answered from a Herdr reading up to
//                                                   BOOT_SCAN_MAX_AGE_MS old (a fresh one is taken meanwhile). It also says { board: { page, boards, write: { marks } } }
//                                                   where the Tasks page is served from the address asked (the board's flag, and on the TLS
//                                                   address its tailnet flag), for the reader page's Tasks link; boards maps a conversation
//                                                   to the board that reads it, from the boards already read
//   GET  /api/transcript-reader/permissions[?session=<id>][&rev=<n>&wait=<ms>]   Claude Code's permission asks (permissions.js; README, "Permission asks from Claude")
//                                                   for one session or all: the open ask(s) and the newest records, with the revision; with rev and wait it answers when
//                                                   something changed after that revision (or after the wait). Reading it is what tells the server a page is open and
//                                                   looking. 404 unless the reader is started with PMOS_READER_PERMISSIONS=1
//   POST /api/transcript-reader/permission-answer   { id, shown, decision: "allow" | "deny" }: answers the ask the hook of that Claude run is holding; loopback only,
//                                                   refused when what was shown is not the live ask, when the hook is no longer waiting or when Herdr no longer reports the pane at a prompt
//   POST /api/transcript-reader/permission-ask      the hook's own route (hooks/permission-hook.py), not a page's: loopback only, its own key in a header (not the page token),
//                                                   and refused when the request carries an Origin or Fetch-Metadata header. Holds the call until an answer or a limit
//   GET  /api/transcript-reader/open-asks           the conversations that ask you something, one for each live Herdr pane, newest ask
//                                                   first (README, "The open-asks route"); read from the glance feed and Herdr, parses nothing
//   GET  /api/transcript-reader/events?reader=<stamp>&sheet=<stamp>&wait=<ms>
//                                                   answers with the build stamps as soon as a page build is newer than the
//                                                   stamp(s) given, or after the wait (at most 30 s) with the same stamps: how an
//                                                   open page learns of a new build at once instead of at its next poll
//   GET  /api/transcript-reader/board?session=<id>  the Tasks board of one session (board.js; board/README.md), as JSON; 404 unless the reader is
//                                                   started with PMOS_READER_BOARD=1, and not on the tailnet listeners unless PMOS_READER_BOARD_TAILNET=1 too (the TLS one only, reads only)
//   GET  /api/transcript-reader/board-sessions      the sessions that have a board (same flag, same limits)
//   POST /api/transcript-reader/board-{mark,answer,review,round,worker}  the board's writes (board.js): a reply mark, an answer and a review outcome, each behind a flag of its own, and a worker's
//                                                   on/off switch; GET /setup/transcript-reader/board/ is its page (loopback only)
//   GET  /api/transcript-reader/board-reply         the whole text of one reply a card shows (board.js), read only
//   POST /api/transcript-reader/board-send          the card view's message box: the board's flag (PMOS_READER_BOARD_SEND=1) and a supervisor session its own
//                                                   transcripts name, then the reader's own Send (below), unchanged
//   POST /api/transcript-reader/sync                the Sync button: reads Herdr again at once, lists every live
//                                                   Claude pane's session that is not listed (unless a person closed
//                                                   or removed it) and rebuilds the pages from the session logs and
//                                                   the fleet records, then answers as state does, with the time
//                                                   it finished
//   POST /api/transcript-reader/copy-sync           the hosted and sealed copies' Sync button: { copy: "bucket" | "hosted" } has the laptop
//                                                   build that copy now (copysync.js: sync.py --seal, or --build-only for the plain copy,
//                                                   as the LaunchAgent would), or joins the build already running, and answers { copy,
//                                                   state: "running" | "done" | "failed", startedAt, finishedAt, message }
//   GET  /api/transcript-reader/copy-sync?copy=<c>  the same state, for the page to ask again until the build is over
//   GET  /api/transcript-reader/steps?conv=<id>     the tool output of one conversation of the local page, { outputs: { "<turn>:<n>": text } },
//                                                   read from out/steps/<id>.json, which the page build writes beside the page (the page itself
//                                                   holds none of it); an empty set for a conversation with none. Read only.
//   GET  /api/transcript-reader/pins                the pinned messages (pinstore.js: a small owner-only file
//                                                   outside the repo) and their revision
//   POST /api/transcript-reader/pins                { op: "pin", key, conv, at[, description] }, { op: "describe", key, description } or { op: "unpin", key }
//   GET  /api/transcript-reader/stars               the starred sessions of the picker (the same store, in a file
//                                                   beside the pins) and their revision
//   POST /api/transcript-reader/stars               { op: "star", conv } or { op: "unstar", conv }
//   GET  /api/transcript-reader/sheet-flags         the replies marked "should be an answer sheet" or "this sheet is wrong" (a third
//                                                   file beside the pins; turn ids only, never a reply's text) and their revision
//   POST /api/transcript-reader/sheet-flags         { op: "flag", key, conv, at, kind: "missing"|"wrong" } or { op: "unflag", key }
//   GET  /api/transcript-reader/hidden              the messages and replies hidden from the reader's view (a fourth file beside the
//                                                   pins; turn ids only, never a message's text; the agent's session log is never touched)
//                                                   and their revision
//   POST /api/transcript-reader/hidden              { op: "hide", key, conv, at } or { op: "unhide", key }
//   POST /api/transcript-reader/add-tab             { session_id }: lists the session of a live Herdr tab the reading list lacks (state's `tabs`) and
//                                                   builds it at once, answering when the page is built (the closed-pane sweep and the chain
//                                                   walk of every other session are left to the next ordinary rebuild)
//   POST /api/transcript-reader/rerender            {}: builds the pages again now (the worker starts from the code on disk), answers when built
//   POST /api/transcript-reader/send                { session_id, text[, images] }: empties the input box
//                                                   of the one live Herdr pane running that
//                                                   session, then sends the text there. images are the ids
//                                                   upload gave: each is added to the text as a line
//                                                   "Attached image: <absolute path>" (the way Claude Code is
//                                                   pointed at a picture), and the answer then carries the text
//                                                   as sent. With images, text may be empty (not a / command).
//   POST /api/transcript-reader/upload              { data[, name] }: one photo, base64 in the JSON body every
//                                                   route takes, saved owner-only (0600 in a 0700 folder) as
//                                                   out/uploads/<random>.<png|jpg|gif|webp> after its bytes are
//                                                   checked (see "Photos" below): { id, bytes, type }
//   POST /api/transcript-reader/queue               a hosted copy's Send: { copy: "hosted", id, object:
//                                                   { session_id, text, at } } writes out/hosted/q/<id>.json;
//                                                   { copy: "bucket", id, data } writes the sealed bytes the
//                                                   page made (base64) to out/bucket/q/<id>.json.enc, so the
//                                                   server never sees the text. Nothing is sent to Herdr:
//                                                   drain.js (run by the sync agent) delivers it later.
//   POST /api/transcript-reader/unqueue             takes a queued message back: { copy, id }. { state: "cancelled" } when it
//                                                   was waiting (now never sent) or this server never had it (and now refuses
//                                                   it), { state: "too_late" } when the drain has it, which the receipt then
//                                                   says. The rename the drain claims with and this route's are the same
//                                                   atomic step, so exactly one of them has the message.
//   POST /api/transcript-reader/html-open          { id }: an HTML file the page offers (listed beside it in
//                                                   out/html-files.json) is checked now (still there, under the
//                                                   home or a temp folder, not over the size limit) and given an
//                                                   address: { url, name, size, mtime }
//   POST /api/transcript-reader/image-open          { id }: the same for an image file the page offers (listed in
//                                                   out/image-files.json): { url, name, size, mtime }
//   POST /api/transcript-reader/md-open             { id }: the same for a markdown file the page lists without its text (out/md-files.json:
//                                                   the files of a leader's task folders that no conversation named; out/live/md-files.json:
//                                                   the files the lite page's conversations name), checked now and
//                                                   read: { text, name, size, mtime }. Read only.
//   GET  /api/transcript-reader/html/<key>/<file>   that file, and the files beside it and below it that it names, as
//                                                   they are on disk now, for the page to show in a sandboxed frame
//                                                   (see "HTML files" below); the key in the address is the credential.
//                                                   An image's address serves that image and nothing else.
//   POST /api/transcript-reader/reopen              { session_id }: lists a session whose pane
//                                                   has closed, to read again, and rebuilds
//   POST /api/transcript-reader/close               { session_id }: takes a session off the
//                                                   reading list and rebuilds
//
// The pages embed private transcripts, so they are served here rather than by the
// shared static handler, which sends Access-Control-Allow-Origin: *. Every route
// uses the Herdr organizer's guard (exact Host and Origin, Fetch-Metadata, token)
// and never sends an Access-Control-Allow-* header.
//
// HTML files. A reply that names an HTML file (a throwaway sketch, a report) gets a button; the page
// asks html-open for an address and shows it in an iframe with sandbox="allow-scripts" and no
// allow-same-origin, so the file's scripts run but cannot reach the reader's origin, cookies, token
// or API. That frame, and the files it loads, send no token, and a sandboxed frame is cross-site
// to everything (Fetch-Metadata, SameSite), so the address itself is the credential: a random key
// minted by html-open (token-guarded), held in memory for an hour of disuse and handed to no one
// else. Every answer carries a Content-Security-Policy that sandboxes the response itself and lets
// the file load only what sits beside it (no network, no frames, no forms, no fetch), and the
// guard still checks Host (so DNS rebinding cannot reach it) and Origin. Only files under the home
// and temp folders are served, only those the page offers, and beside one only files below its own
// folder (never a dot file or folder, never a link out of it, and only the types in ASSET_TYPES);
// an HTML file directly in the home or a temp folder gets its own folder's files and no deeper.
//
// Image files (.png .jpg .jpeg .gif .webp .svg) a reply names are offered the same way (image-open, the same kind of address,
// the same folder and link rules), but the page shows one in an <img> of its own, not a frame, so an SVG's scripts never run
// (an image document runs none), and the address serves that one file and nothing beside it. The response is sandboxed by its own
// policy too, so an SVG opened alone in a tab runs no script either.
//
// A request that came in on the Tailscale listener (server.js, opt-in) first goes through
// tailnet.js: a passcode and a session cookie on top of all of this, with that listener's own
// Host and Origin. Loopback requests do not.
//
// The reader has its own server, but the token is still never handed out by an endpoint.
// It is written into a page only when the browser opens that page as a top-level
// document (Fetch-Metadata navigate/document), and the page refuses framing and
// cuts off its opener. A script on another page of this origin therefore cannot
// fetch, frame or open a page to read the token, the transcripts or send a prompt.
//
// Writes: reader.py rebuilds the pages when a listed session log changes or a listed
// session's pane closes (dropping it from the reading list), and adds the session
// Herdr has focused to the reading list while a page follows focus. While a page is open (it polls, or waits on events) the
// server itself watches the folders of the listed logs and starts the rebuild when one changes, rather than at the page's
// next poll; with no page open it watches nothing and rebuilds nothing. The rebuilds run in one reader.py that stays running
// (worker.js), which falls back to a fresh reader.py for a request it cannot take. Each rebuild also leaves the lite page's files in out/live/
// and the glance feed in out/glance.json (build_prototype.write_live); this module serves the first and reads the second only for open-asks. reopen and close
// change the reading list only on a click in the page, and so does sync, which also lists
// every live Claude pane's session not yet listed, except one a person closed or removed. The one other change to the list that is not a click is a pane that a listed conversation ran in moving on to a new session (a /clear): the new session is listed (adopt) once it has a log. The pins, stars and sheet-flags files are the only things written outside out/, and only on a pin, an unpin, a star, an unstar, a mark or a cleared mark.
// A prompt reaches a pane only through send, which the page calls on a click, or through
// the hosted copy's queue: queue writes the request to a folder and drain.js sends it later
// through this module's own sendPrompt, so both routes check the pane the same way.
// Nothing here starts, stops or closes a Herdr session, tab or pane.
//
// Claude config folders. A Claude run with another CLAUDE_CONFIG_DIR keeps its sessions/ records and projects/ logs in that
// folder, and Herdr's hook names no session for its pane, so every lookup of a Claude log or running process reads ~/.claude and
// each other config folder (otherClaudeHomes: any ~/.claude* folder with projects/ or sessions/, CLAUDE_CONFIG_DIR, and
// PMOS_READER_CLAUDE_HOMES). create({ projectsDir, claudeSessionsDir }) reads those two alone, unless claudeHomes adds more.
//
// Photos. The message bar can attach pictures. A page uploads each one first (upload: the same guard as every
// route, so the same Host, Origin, token and, on the tailnet, sign-in), and then names the saved ids in send, which
// adds their paths to the text. What is saved is decided here, from the bytes and never from the name the page gave:
// PNG, JPEG, GIF and WebP by their headers, and HEIC (an iPhone's) converted to JPEG with macOS's sips because Claude
// Code cannot read HEIC; anything else is refused. A photo is at most 12 MB, a message carries at most 6 photos and
// 30 MB, a saved file has a random name and its type's extension, and the folder holds at most 1 GB, files older than 30
// days being removed as new ones arrive. Saved photos are never served: the folder is under out/, which this module
// claims whole (no route lists or serves it), and the page shows its own thumbnails from the file the person picked.
// The hosted copy's queue cannot carry photos (its text is sealed, and a photo is far past its size), so it takes none.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createGuard } = require('../herdr-organizer/guard');
const tailnetLane = require('./tailnet');
const deltaStore = require('./delta');
const pinstore = require('./pinstore');
const workerLib = require('./worker');
const copySyncLib = require('./copysync');
const boardLib = require('./board');
const permissionsLib = require('./permissions');
const permLogLib = require('./permlog');
const { otherClaudeHomes, runningClaudeSessions } = require('./claude-homes');
const { childEnv, defaultRunner, SESSION_NAME_RE } = require('../herdr-organizer/adapter');
// The store API's code (storeapi/) is loaded only when the flag is on, so a copy of the reader without it, or with the flag off, runs none of it.
const WINDOWED_PAGE = '/setup/transcript-reader/windowed/index.html';

const API = '/api/transcript-reader/';
const PAGES = new Set(['prototype.html', 'questionnaire.html', 'live/index.html', 'live/sheet.html', 'live/embed.html', 'hosted/index.html', 'hosted/sheet.html', 'bucket/index.html', 'bucket/sheet.html']);
// The hosted copy's objects by their path under out/hosted/ (sync.py names them), and the sealed
// copy's under out/bucket/. The manifest, the pane cache and the upload records are never served.
const OBJECTS = {
  // The lite page's (out/live/): the index, and one conversation's entry (s/) and answer sheet (a/) each. Its markdown listing (md-files.json) is read by md-open, never served.
  live: { re: /^(?:index|[sa]\/[A-Za-z0-9_-]{1,64})\.json$/, type: 'application/json; charset=utf-8' },
  hosted: { re: /^(?:index|[sdfart]\/[A-Za-z0-9_-]{1,64})\.json$/, type: 'application/json; charset=utf-8' },
  bucket: { re: /^(?:(?:index|[sdfart]\/[A-Za-z0-9_-]{1,64})\.json\.enc|k\/params\.json)$/, type: 'application/octet-stream' },
};
// The shell pages of a copy: opened in a tab (and so given the token), or, for the offline copy's cache, fetched by the page itself
// with the token it already holds (see servePage).
const SHELL_PAGES = new Set(['hosted/index.html', 'hosted/sheet.html', 'bucket/index.html', 'bucket/sheet.html']);
// What sits beside a copy's shell pages and holds no transcript: the offline copy's service worker, its manifest and icons (sync.py).
const STATIC_TYPES = {
  'sw.js': 'text/javascript; charset=utf-8', 'manifest.webmanifest': 'application/manifest+json; charset=utf-8',
  'icon-180.png': 'image/png', 'icon-512.png': 'image/png',
};
const TOKEN_HEADER = 'x-transcript-reader-token';
const BOARD_PAGE = '/setup/transcript-reader/board/';
const HTML_ROUTE = API + 'html/';
const HTML_FILES = 'html-files.json';  // beside the page: id -> path (build_prototype.write_page)
const IMAGE_FILES = 'image-files.json';  // the same for the images the page offers
const MD_FILES = 'md-files.json';  // the same for the markdown files the page lists without their text (a leader's task folders)
const LIVE_MD_FILES = 'live/md-files.json';  // and for the markdown files the lite page's conversations name: it lists them without their text too
const HTML_ID_RE = /^[0-9a-f]{10}$/;
const HTML_PAGE_RE = /\.html?$/i;
const IMAGE_FILE_RE = /\.(?:png|jpe?g|gif|webp|svg)$/i;
const MD_FILE_RE = /\.md$/i;
// build_prototype.MAX_HTML_BYTES and MAX_IMAGE_BYTES: what the page offers. A file beside an HTML page may be larger (a picture).
const MAX_HTML_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_DOC_BYTES = 512 * 1024;  // build_prototype.MAX_DOCUMENT_BYTES: a markdown file the page opens
const MAX_ASSET_BYTES = 32 * 1024 * 1024;
const VIEW_IDLE_MS = 60 * 60 * 1000;
const MAX_VIEWS = 64;
const TEXT_UTF8 = (type) => type + '; charset=utf-8';
// What a shown file may load from its folder: its pages, styles, scripts and pictures. Fonts, media and
// anything else are not served (a font or a module script is a CORS fetch, which this server never answers).
const ASSET_TYPES = {
  '.html': TEXT_UTF8('text/html'), '.htm': TEXT_UTF8('text/html'), '.css': TEXT_UTF8('text/css'), '.js': TEXT_UTF8('text/javascript'),
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.bmp': 'image/bmp',
};
// The file's own scripts and styles run (inline, or from beside it) and nothing leaves: no network, no frames, no forms.
// "sandbox allow-scripts" makes the response itself a sandboxed page whatever frames it, or opens it alone in a tab.
const VIEW_CSP = ["sandbox allow-scripts", "default-src 'none'", "script-src 'self' 'unsafe-inline'", "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:", "font-src 'self' data:", "media-src 'self' data: blob:", "connect-src 'none'", "frame-src 'none'",
  "object-src 'none'", "form-action 'none'", "base-uri 'self'", "frame-ancestors 'self'"].join('; ');
const ASSET_CSP = "sandbox; default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'self'";
// Names the copy of the repo whose pages this server serves, so reader.py and serve.sh can tell
// their own copy's server from another copy's on the same port (reader.py's copy_id computes the same).
const COPY_HEADER = 'x-transcript-reader-copy';
const copyId = (root) => crypto.createHash('sha256').update(fs.realpathSync(root)).digest('hex').slice(0, 16);
// The templates carry this tag; the server fills it in at serve time, so the built
// file never holds a token and the build-time script hash stays valid. The page's
// payload escapes every "<", so the tag cannot occur in transcript text.
const TOKEN_SLOT = '__READER_TOKEN__';
const TOKEN_META = '<meta name="reader-token" content="' + TOKEN_SLOT + '">';
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const COPILOT_EVENTS = 'events.jsonl';
const COPILOT_SEND_REFUSAL = 'Sending to Copilot is not supported yet.';
// What a running Copilot process writes to its own log each time it shows a session: at its start, and at every /resume and /new.
const COPILOT_REGISTERED_RE = /(\d{4}-\d\d-\d\dT[\d:.]+Z) \[[A-Z]+\] Registering foreground session: ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/g;
const COPILOT_PANES_KEEP_DAYS = 14;
const COPILOT_LOG_READ_MAX = 64 * 1024 * 1024;
const CODEX_ROLLOUT_RE = /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\.jsonl)?$/;
const PANE_ID_RE = /^w[A-Za-z0-9]{1,10}:p[A-Za-z0-9]{1,10}$/;
// Newline and tab are the only control characters a message may carry, so no escape
// sequence (such as the end of a bracketed paste) can reach the terminal.
const CONTROL_RE = /[\u0000-\u0008\u000b-\u001f\u007f]/;
const MAX_TEXT = 4000;
const SENDABLE = new Set(['idle', 'working', 'done']);
// Text left unsent in the pane's input box would join the front of a message, so send
// empties the box first. Ctrl+K and Ctrl+U delete to the end and the start of one screen
// line, and at a line's end or start remove the line break, so pairs of them empty the box
// from wherever the cursor is, and neither interrupts a working agent the way Ctrl+C or
// Esc would. Claude Code ignored a burst of 32 pairs in one write (25 went through), so the
// keys go a few pairs per call with a pause between. 25 calls clear 100 screen lines.
const CLEAR_KEYS = ['ctrl+k', 'ctrl+u', 'ctrl+k', 'ctrl+u', 'ctrl+k', 'ctrl+u', 'ctrl+k', 'ctrl+u'];
const CLEAR_CALLS = 25;
const CLEAR_PAUSE_MS = 40;
// Codex opens a skill autocomplete popup for a leading `$`; let it settle before Herdr submits the prompt.
const CODEX_SKILL_SETTLE_MS = 1200;
const MAX_BODY_BYTES = 16 * 1024;
// Photos (see above). prototype/attach.js holds the first three for the page's own checks; a test keeps them equal.
const MAX_PHOTOS = 6;
const MAX_PHOTO_BYTES = 12 * 1024 * 1024;
const MAX_PHOTOS_BYTES = 30 * 1024 * 1024;
// A photo travels as base64 inside a JSON body (the guard takes only application/json), a third larger than the file.
const MAX_UPLOAD_BODY_BYTES = Math.ceil(MAX_PHOTO_BYTES * 4 / 3) + 4096;
const UPLOADS = 'uploads';
const UPLOAD_NAME_RE = /^[0-9a-f]{32}\.(?:png|jpg|gif|webp)$/;
const UPLOAD_KEEP_MS = 30 * 24 * 60 * 60 * 1000;
const UPLOAD_TEMP_KEEP_MS = 60 * 60 * 1000;
const UPLOADS_FULL_BYTES = 1024 * 1024 * 1024;
const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1']);
// A queued send carries up to MAX_TEXT characters, sealed and in base64, so its route takes a larger body.
const MAX_QUEUE_BODY_BYTES = 64 * 1024;
const MAX_QUEUED = 50;
// Messages taken back leave an empty .cancelled-<id> file in q/ for drain.js to forget after two days.
const MAX_TOMBSTONES = 200;
const cancelledName = (id) => '.cancelled-' + id;
const QUEUE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SEALED_MAGIC = Buffer.from('HRC1');
const SCAN_TTL_MS = 700;
// A page that has just opened asks for the state once, and its dock cannot name a pane until it comes: a reading this old is answered at once, and a new one is
// taken meanwhile, which the page's next call (two seconds on) sees. Every later call, and Send, wants a fresh one.
const BOOT_SCAN_MAX_AGE_MS = 10000;
// Between two rebuilds, a short pause: a log changed during a rebuild is picked up by the next one at once, and a writer that
// writes without a pause does not start rebuilds faster than a build can finish.
const REBUILD_GAP_MS = 250;
// And between the starts of two rebuilds started because logs changed, at least this. A rebuild costs the worker what changed in the
// logs, which is little, so without a limit a session that writes every second is rebuilt for every second, and the cost is each
// build's page published and read again by every open page. The first write after a quiet spell is rebuilt for at once; the writes that
// follow within this are rebuilt for together, once it is over, so a new reply is on the page within this much of being written (a
// rebuild that took longer than this is followed by the pause above alone).
const REBUILD_EVERY_MS = 2000;
// While a page is open, the logs are looked at this often besides the file system's own notice (which can be missed), and a
// page seen this recently keeps the server watching.
const SWEEP_MS = 500;
const PRESENCE_MS = 20000;
const MAX_WAIT_MS = 30000;
const WARM_MS = 60 * 60 * 1000;  // a page seen this recently keeps the rebuild worker running while it idles
const RETRY_AFTER_FAILURE_MS = 30000;
// A markdown file opened on request is read for at most this long, and a folder whose read did not answer is not asked again for the hold: macOS
// holds Downloads and Desktop behind a permission dialog for an app, and until it is answered an open there waits for good (the build side of this is
// prototype/bounded_read.py). The read is asynchronous, so a file that never answers costs a request and a pool thread, never the whole server.
const MD_READ_MS = 5000;
const MD_HOLD_MS = 5 * 60 * 1000;

class RequestError extends Error {
  constructor(message, status = 400, code = 'error') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(body));
}

function fail(res, status, code, message) {
  send(res, status, { status: 'error', code, message });
}

function readJsonBody(req, limit = MAX_BODY_BYTES, tooLong = { message: 'Message too long.', code: 'error' }) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let done = false;
    const chunks = [];
    req.on('data', (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > limit) { done = true; reject(new RequestError(tooLong.message, 413, tooLong.code)); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
        resolve(value);
      } catch { reject(new RequestError('Invalid JSON body.')); }
    });
    req.on('error', () => { if (!done) { done = true; reject(new RequestError('Request failed.')); } });
  });
}

// The message exactly as the page showed it, or a RequestError saying why not.
function checkText(value) {
  if (typeof value !== 'string') throw new RequestError('Write a message first.');
  const text = value.replace(/\r\n?/g, '\n').trim();
  if (!text) throw new RequestError('Write a message first.');
  if (text.length > MAX_TEXT) throw new RequestError('The message is over ' + MAX_TEXT + ' characters.', 413, 'too_long');
  if (CONTROL_RE.test(text)) throw new RequestError('The message contains control characters.');
  // Herdr would read a leading dash as an option.
  if (text.startsWith('-')) throw new RequestError('The message cannot start with a dash.');
  return text;
}

function parseJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

const megabytes = (bytes) => (bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0) + ' MB';

// What a photo's bytes say it is: { ext, type } for a PNG, JPEG, GIF or WebP, { heic: true } for an iPhone's HEIC, else null.
// The headers are read, not just the first bytes (a PNG must open with its IHDR chunk and a size, a GIF with its screen size,
// a JPEG with a marker a JPEG can start with, a WebP with a size that fits the file), so a text file or a page renamed .png is refused.
function sniffImage(b) {
  const at = (from, to) => b.toString('latin1', from, to);
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a && at(12, 16) === 'IHDR'
    && b.readUInt32BE(16) > 0 && b.readUInt32BE(20) > 0) return { ext: '.png', type: 'image/png' };
  if (b.length >= 20 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff
    && ((b[3] >= 0xe0 && b[3] <= 0xef) || [0xc0, 0xc1, 0xc2, 0xc4, 0xdb, 0xfe].includes(b[3]))) return { ext: '.jpg', type: 'image/jpeg' };
  if (b.length >= 13 && /^GIF8[79]a$/.test(at(0, 6)) && b.readUInt16LE(6) > 0 && b.readUInt16LE(8) > 0) return { ext: '.gif', type: 'image/gif' };
  if (b.length >= 20 && at(0, 4) === 'RIFF' && at(8, 12) === 'WEBP' && ['VP8 ', 'VP8L', 'VP8X'].includes(at(12, 16))
    && b.readUInt32LE(4) + 8 <= b.length) return { ext: '.webp', type: 'image/webp' };
  if (b.length >= 16 && at(4, 8) === 'ftyp' && HEIC_BRANDS.has(at(8, 12))) return { heic: true };
  return null;
}

// Where a path really is, as the file system resolves it: the nearest existing
// part goes through realpath (symlinks, and macOS's own case and Unicode folding),
// and the missing rest is appended as spelled.
function realLocation(full) {
  const rest = [];
  let head = full;
  for (;;) {
    try { return path.join(fs.realpathSync.native(head), ...rest); } catch { /* not there: try its parent */ }
    const parent = path.dirname(head);
    if (parent === head) return full;
    rest.unshift(path.basename(head));
    head = parent;
  }
}

// Any request whose path lands in out/ belongs to the reader, however it is spelled (encoded
// slashes, doubled slashes, another letter case or Unicode form, a symlink), so no static
// handler ever serves a page or the reading list with a wildcard CORS header. Both spellings
// are checked: the parsed URL, and the raw one that a static file handler would decode.
function requestsOut(root, outDir, req, url) {
  const realOut = realLocation(outDir);
  for (const spelling of [url.pathname, req.url.split('?')[0]]) {
    let decoded;
    try { decoded = decodeURIComponent(spelling); } catch { return { inside: true, name: '' }; }
    const real = realLocation(path.join(root, decoded));
    if (real === realOut || real.startsWith(realOut + path.sep)) return { inside: true, name: path.relative(realOut, real) };
  }
  return { inside: false };
}

// For a server that serves repo files for other apps (setup/serve.sh): whether the request
// names the reader's out/ folder, which that server must refuse.
function namesReaderOut(root, req) {
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch { return true; }
  return requestsOut(root, path.join(root, 'setup', 'transcript-reader', 'out'), req, url).inside;
}

function canonicalSessionId(value) {
  if (typeof value !== 'string') return null;
  if (SESSION_ID_RE.test(value)) return value;
  if (path.basename(value) === COPILOT_EVENTS && SESSION_ID_RE.test(path.basename(path.dirname(value)))) return path.basename(path.dirname(value));
  const match = CODEX_ROLLOUT_RE.exec(path.basename(value));
  return match ? match[1] : null;
}


// A pane's name as Herdr shows it: its own label, else its tab's label, else the terminal title.
function readSnapshot(name, snapshot) {
  const tabLabels = new Map((snapshot.tabs || []).map((tab) => [tab.tab_id, tab.label || '']));
  const panes = [];
  for (const pane of snapshot.panes || []) {
    const sessionId = (pane.agent_session || {}).value;
    if (typeof pane.pane_id !== 'string' || !PANE_ID_RE.test(pane.pane_id)) continue;
    panes.push({
      pane_id: pane.pane_id,
      session_id: canonicalSessionId(sessionId),
      agent: typeof pane.agent === 'string' ? pane.agent : null,
      status: typeof pane.agent_status === 'string' ? pane.agent_status : 'unknown',
      label: String(pane.label || tabLabels.get(pane.tab_id) || pane.terminal_title_stripped || pane.pane_id).slice(0, 120),
    });
  }
  return { name, focused: typeof snapshot.focused_pane_id === 'string' ? snapshot.focused_pane_id : null, panes };
}


function create({
  root, port, runner = defaultRunner, env = process.env, now = () => Date.now(),
  pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  herdrBin = 'herdr', pythonBin = 'python3', projectsDir: projectsOption, claudeSessionsDir: claudeSessionsOption,
  // The config folders of a Claude run with another CLAUDE_CONFIG_DIR, whose projects/ and sessions/ are read like ~/.claude's: left
  // out, they are found (otherClaudeHomes) unless the two folders above are given, which means a test or a lab reading only those.
  claudeHomes,
  codexSessionsDir = path.join(os.homedir(), '.codex', 'sessions'),
  // The Copilot CLI's home: session-state/<session id>/events.jsonl is a conversation, logs/process-<start>-<pid>.log a running process's own log.
  copilotHomeDir = path.join(os.homedir(), '.copilot'),
  outDir = path.join(root, 'setup', 'transcript-reader', 'out'), token,
  pinsFile = pinstore.defaultFile(env),
  starsFile = pinstore.defaultStarsFile(env),
  sheetFlagsFile = pinstore.defaultSheetFlagsFile(env),
  hiddenFile = pinstore.defaultHiddenFile(env),
  permissionsFile = permissionsLib.defaultFile(env),
  permissionsHookFile = permissionsLib.defaultHookFile(env),
  // Where an HTML file may be shown from, as in build_prototype.resolve_mention: the home folder and the temp folders.
  homeDir = os.homedir(), tempRoots = ['/tmp', os.tmpdir()],
  // The session ids sendPrompt accepts, when not the reading list's: drain.js sends to the
  // conversations of the hosted copy it drains.
  sendable = null,
  // { ip, port, passcodeFile[, https: { host, port }] } when server.js also listens on the Mac's Tailscale address
  // (tailnet.js), and with https on a TLS listener there too under the machine's Tailscale name (host); handle()
  // then takes the listener a request came in on.
  tailnet = null,
  // Where the tailnet listener writes its sign-in record (a line of text each); the server's stderr when left out.
  log = undefined,
  // Rebuilds in one reader.py that stays running (worker.js) instead of a new one each time; server.js turns it on.
  worker = false,
  // Watching the listed logs while a page is open, and answering `events` as a build is published; server.js turns it on.
  watch = false, sweepMs = SWEEP_MS,
  // macOS's converter for an iPhone's HEIC photos (an absolute path, so the server's own PATH does not matter).
  sipsBin = '/usr/bin/sips',
  // The least time between the starts of two rebuilds that changed logs started (REBUILD_EVERY_MS); a test of something else asks for none.
  rebuildEveryMs = REBUILD_EVERY_MS,
  // How long a markdown file opened on request may take to read (MD_READ_MS); a test of that asks for less.
  mdReadMs = MD_READ_MS,
  // The Tasks board's data routes (board.js): true or an options object turns them on (the default follows PMOS_READER_BOARD=1).
  board: boardOption,
  // Claude's permission asks answered from the page (permissions.js): true or an options object turns it on (the default follows PMOS_READER_PERMISSIONS=1).
  permissions: permissionsOption,
  // The store-backed API (S2, storeapi/): off unless this is set (server.js sets it from PMOS_READER_STORE_API). { store, watch, compat }: the
  // store's folder or file, Herdr watch timings, and whether the compatibility writers keep out/pane-labels.json (and glance.json) current.
  // With it on, Herdr is watched through its event stream instead of read on a timer, the routes in storeapi/index.js answer, and the windowed
  // lite page is served. Every old route and page is unchanged.
  storeApi: storeApiOption = null,
} = {}) {
  const projectsDir = projectsOption || path.join(os.homedir(), '.claude', 'projects');
  const claudeSessionsDir = claudeSessionsOption || path.join(os.homedir(), '.claude', 'sessions');
  // The Claude config folders read besides ~/.claude, looked at again each time: a new account's folder shows up with no restart.
  const otherHomes = () => (claudeHomes !== undefined ? claudeHomes : (!projectsOption && !claudeSessionsOption ? otherClaudeHomes({ env }) : []));
  const claudeProjectDirs = () => [projectsDir, ...otherHomes().map((home) => path.join(home, 'projects'))];
  const claudeSessionDirs = () => [claudeSessionsDir, ...otherHomes().map((home) => path.join(home, 'sessions'))];
  // Every request a guard refuses is one line in the server's log (tailnet.js refusalLog), on the loopback listener here and on the tailnet ones in their lanes.
  const guard = createGuard({ port, token, tokenHeader: TOKEN_HEADER, onRefuse: tailnetLane.refusalLog({ listener: 'loopback', log: log || undefined, now }) });
  const laneOptions = tailnet && { token: guard.token, tokenHeader: TOKEN_HEADER, passcodeFile: tailnet.passcodeFile, now, ...(log ? { log } : {}) };
  const lane = tailnet && tailnetLane.create({ ...laneOptions, ip: tailnet.ip, port: tailnet.port || port });
  // The TLS listener's lane: the same passcode file, sessions and token, its own Host and Origin (https://<name>:<port>).
  const httpsLane = tailnet && tailnet.https && tailnetLane.create({ ...laneOptions, ip: tailnet.ip, host: tailnet.https.host, scheme: 'https', port: tailnet.https.port });
  // The guard that holds for a request: the loopback one, or the tailnet listener's (its own
  // Host and Origin, the same token). Set by handle().
  const guards = new WeakMap();
  const guardFor = (req) => guards.get(req) || guard;
  // The answer to a request the guard refused: the short page for a tab opening the address, otherwise plain(), the route's own answer.
  const refused = (req, res, verdict, plain) => tailnetLane.refuse(req, res, verdict, guardFor(req).origin, plain);
  const listeners = new WeakMap();  // the listener each request came in on, for the phone's scope (W3)
  const readerScript = path.join(root, 'setup', 'transcript-reader', 'reader.py');
  const copy = copyId(root);
  const runEnv = () => childEnv(env);
  const logPaths = new Map();
  let scanned = null;
  let scanning = null;
  const focusSeen = new Map();
  const focus = { seq: 0, herdr: null };
  const build = { running: null, lastEnd: 0, lastStart: -Infinity, failedAt: 0, error: null, failedAdds: new Map(), paneClosed: false, newest: 0, rebuiltFor: 0 };

  // Listed sessions seen running in a pane. One that leaves while Herdr still answers had
  // its pane closed or cleared, so a rebuild runs and reader.py drops it from the list.
  const seenLive = new Set();
  let sending = false;
  const pins = pinstore.create({ file: pinsFile, now });
  pins.normalize();  // a pins file from before is oldest first; the newest pin goes first now, in the file and so on every page
  const stars = pinstore.createStars({ file: starsFile, now });
  stars.normalize();  // a stars file from before is oldest first; Conn's row reads the file as it stands, and the newest star goes first
  const sheetFlags = pinstore.createSheetFlags({ file: sheetFlagsFile, now });
  const hidden = pinstore.createHidden({ file: hiddenFile, now });
  // The store API's own object (routes, stream, compatibility writers), made once the stars store it reads exists.
  const paneWatch = storeApiOption ? require('./storeapi/herdr-watch').createPaneWatch({
    runner, herdrBin, env, readSnapshot, runEnv: () => runEnv(), sessionNameOk: (name) => SESSION_NAME_RE.test(name), ...(storeApiOption.watch || {}),
  }) : null;
  const storeApi = storeApiOption ? require('./storeapi').createStoreApi({
    store: storeApiOption.store || {}, env, now, outDir, watch: paneWatch, stars, send, fail, RequestError, compatWrite: storeApiOption.compat || false,
    pageSource: () => storeApiPage(), pollMs: storeApiOption.pollMs,
  }) : null;
  // The recent builds of the reader page, for answering what changed since the one an open page holds (delta.js).
  const deltas = deltaStore.create();
  // A reader that runs for real (watch: server.js turns it on) remembers each board on disk and reads them all once at start (board.js says why); a test's does not.
  const board = boardLib.create({ root, env, now, pythonBin, persistDir: watch ? boardLib.boardCacheDir(env) : null, warm: watch, ...(boardOption && typeof boardOption === 'object' ? boardOption : {}), ...(boardOption ? { enabled: true } : {}) });
  // Claude Code's permission asks, answered from the page. The hook (hooks/permission-hook.py) posts an ask and waits; the page shows it and answers it.
  // Off unless PMOS_READER_PERMISSIONS=1, and then only on the laptop's own page. Herdr is asked afresh for the pane at each answer.
  const permLog = permLogLib.create();
  const permissionsOn = permissionsOption === true || (permissionsOption && typeof permissionsOption === 'object') || env.PMOS_READER_PERMISSIONS === '1';
  const permissions = permissionsLib.create({
    now, enabled: Boolean(permissionsOn), listed: () => listed(),
    file: permissionsFile, hookFile: permissionsHookFile,
    denyInterrupts: env.PMOS_READER_PERMISSIONS_DENY_CONTINUES !== '1',
    paneStatus: async (sessionId, { fresh = false } = {}) => {
      const sessions = await scan(fresh ? { fresh: true } : {});
      const matches = sessions.flatMap((session) => session.panes.filter((pane) => pane.session_id === sessionId));
      return matches.length === 1 ? matches[0].status : null;
    },
    // Whether the session log already holds this tool call's result (permlog.js): the log is found by the session id, never by a path the hook sent.
    logState: async (record) => permLog.state(claudeLogPath(record.session_id), record.tool, record.input),
    ...(permissionsOption && typeof permissionsOption === 'object' ? permissionsOption : {}),
  });
  // The Tasks board on the phone's TLS address: its own flag, off by default (PMOS_READER_BOARD_TAILNET=1 or board.tailnet). Only its page and its read routes go
  // there, behind the same passcode, token, Host and Origin checks as every page of the reader; its writes (mark, answer, worker switch, send) stay loopback-only.
  const boardTailnet = Boolean(board.enabled && httpsLane && ((boardOption && typeof boardOption === 'object' && boardOption.tailnet) || env.PMOS_READER_BOARD_TAILNET === '1'));

  // ------------------------------------------------------------- local records

  function idsIn(name) {
    let text = '';
    try { text = fs.readFileSync(path.join(outDir, name), 'utf8'); } catch { return []; }
    return [...new Set(text.split('\n').map((line) => canonicalSessionId(line.trim())).filter(Boolean))];
  }
  const listed = () => idsIn('sessions.txt');
  // Sessions reader.py dropped because their pane closed, and lists again if one runs in a pane.
  const dropped = () => idsIn('dropped.txt');
  // Sessions a person took off the list (reader.py close and remove), which a Sync does not list again.
  const closedByHand = () => idsIn('closed.txt');

  function stamp(name) {
    try {
      const value = Number(fs.readFileSync(path.join(outDir, name), 'utf8').trim());
      return Number.isFinite(value) ? value : null;
    } catch { return null; }
  }

  // The session's log under <config folder>/projects/<folder>/<id>.jsonl (~/.claude's first, then each other Claude config folder's), or null.
  function claudeLogPath(sessionId) {
    sessionId = canonicalSessionId(sessionId) || sessionId;
    const known = logPaths.get(sessionId);
    if (known && fs.existsSync(known)) return known;
    for (const dir of claudeProjectDirs()) {
      let folders = [];
      try { folders = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const folder of folders) {
        if (!folder.isDirectory()) continue;
        const candidate = path.join(dir, folder.name, sessionId + '.jsonl');
        if (fs.existsSync(candidate)) { logPaths.set(sessionId, candidate); return candidate; }
      }
    }
    return null;
  }

  function logPath(sessionId) {
    sessionId = canonicalSessionId(sessionId) || sessionId;
    const claude = claudeLogPath(sessionId);
    if (claude) return claude;
    const codex = codexRollouts().find((entry) => entry.session === sessionId);
    if (codex) { logPaths.set(sessionId, codex.file); return codex.file; }
    const copilot = copilotLog(sessionId);
    if (copilot) { logPaths.set(sessionId, copilot); return copilot; }
    return null;
  }

  // A Copilot session's events.jsonl, or null: the folder is named for the session, and the file's first record says it is that session's.
  function copilotLog(sessionId) {
    if (!SESSION_ID_RE.test(sessionId || '')) return null;
    const file = path.join(copilotHomeDir, 'session-state', sessionId, COPILOT_EVENTS);
    let first = null;
    try {
      // Only its start: a conversation file is megabytes, and the first record is under a kilobyte.
      const handle = fs.openSync(file, 'r');
      try {
        const buffer = Buffer.alloc(65536);
        const read = fs.readSync(handle, buffer, 0, buffer.length, 0);
        first = parseJson(buffer.subarray(0, read).toString('utf8').split('\n', 1)[0]);
      } finally { fs.closeSync(handle); }
    } catch { return null; }
    return first && first.type === 'session.start' && first.data && first.data.sessionId === sessionId ? file : null;
  }

  // Whether a session's log is a Copilot conversation. Known from its file alone, so no Herdr is asked.
  const isCopilotSession = (sessionId) => { const file = logPath(sessionId); return Boolean(file) && path.basename(file) === COPILOT_EVENTS; };

  // What a Codex rollout's first line says, cached by file path with the file's mtime and size: a rollout is megabytes (a long
  // conversation, 2 GB across the owner's 886 files) and only its first line, a session_meta record of a few kilobytes, is read. A
  // rollout that grows is read again from its start, which is cheap; one that has not changed is not opened. A value is the rollout's
  // entry, or null for a file that is not a CLI session.
  const rolloutHeads = new Map();
  const ROLLOUT_HEAD_CHUNK = 64 * 1024;
  const ROLLOUT_HEAD_MAX = 4 * 1024 * 1024;  // a first line longer than this is not a session_meta record

  // The first line of a file, read from its start in 64 KB pieces until a newline, or null.
  function firstLine(file) {
    const handle = fs.openSync(file, 'r');
    try {
      const chunks = [];
      let total = 0;
      while (total < ROLLOUT_HEAD_MAX) {
        const buffer = Buffer.alloc(ROLLOUT_HEAD_CHUNK);
        const read = fs.readSync(handle, buffer, 0, buffer.length, total);
        if (read <= 0) break;
        chunks.push(buffer.subarray(0, read));
        total += read;
        if (buffer.subarray(0, read).includes(10)) break;
      }
      return Buffer.concat(chunks).toString('utf8').split('\n', 1)[0];
    } finally { fs.closeSync(handle); }
  }

  function rolloutEntry(file, stat) {
    let first;
    try { first = parseJson(firstLine(file)); } catch { first = null; }
    const payload = first && first.payload;
    const session = payload && (payload.id || payload.session_id);
    const cwd = payload && payload.cwd;
    if (!(first && first.type === 'session_meta' && payload && payload.source === 'cli' && SESSION_ID_RE.test(session || '') && typeof cwd === 'string' && cwd)) return null;
    let realCwd;
    try { realCwd = fs.realpathSync.native(cwd); } catch { realCwd = path.resolve(cwd); }
    return { file, session, cwd: realCwd, mtime: stat.mtimeMs };
  }

  function codexRollouts() {
    const found = [];
    const seen = new Set();
    const walk = (folder) => {
      let entries;
      try { entries = fs.readdirSync(folder, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        const file = path.join(folder, entry.name);
        if (entry.isDirectory()) walk(file);
        else if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) {
          let stat;
          try { stat = fs.statSync(file); } catch { continue; }  // a live rollout may disappear
          seen.add(file);
          let head = rolloutHeads.get(file);
          if (!head || head.mtimeMs !== stat.mtimeMs || head.size !== stat.size) {
            head = { mtimeMs: stat.mtimeMs, size: stat.size, entry: rolloutEntry(file, stat) };
            rolloutHeads.set(file, head);
          }
          if (head.entry) found.push(head.entry);
        }
      }
    };
    walk(codexSessionsDir);
    for (const file of rolloutHeads.keys()) if (!seen.has(file)) rolloutHeads.delete(file);
    return found.sort((a, b) => b.mtime - a.mtime);
  }

  // The rollouts, listed on the first ask and kept for the rest of one pass (a scan, a sync): a list per pane would walk the
  // sessions folder once for each.
  const rolloutsOnce = () => { let list = null; return () => (list || (list = codexRollouts())); };

  function mtimeMs(file) {
    try { return fs.statSync(file).mtimeMs; } catch { return 0; }
  }

  // ------------------------------------------------------------------- Herdr

  // Every running named Herdr session with its focused pane and agent panes.
  // Read-only: `herdr session list --json` and `herdr --session <name> api snapshot`.
  async function scan({ fresh = false, maxAge = 0 } = {}) {
    if (paneWatch) return scanFromWatch(fresh);
    if (!fresh && scanned && now() - scanned.at < SCAN_TTL_MS) return scanned.sessions;
    if (!fresh && maxAge && scanned && now() - scanned.at < maxAge) {
      if (!scanning) scan().catch(() => {});  // the reading the next call sees
      return scanned.sessions;
    }
    if (scanning) return scanning;
    scanning = (async () => {
      const listing = await runner(herdrBin, ['session', 'list', '--json'], { env: runEnv(), timeoutMs: 5000 });
      const names = ((listing.code === 0 && parseJson(listing.stdout)) || {}).sessions || [];
      const sessions = [];
      const rollouts = rolloutsOnce();
      for (const entry of names) {
        // The default session is never addressed, as in the organizer; a name must never read as an option.
        if (!entry || !entry.running || entry.default || typeof entry.name !== 'string' || !SESSION_NAME_RE.test(entry.name)) continue;
        const result = await runner(herdrBin, ['--session', entry.name, 'api', 'snapshot'], { env: runEnv(), timeoutMs: 5000 });
        const snapshot = (((result.code === 0 && parseJson(result.stdout)) || {}).result || {}).snapshot;
        if (snapshot) sessions.push(await checkSessions(readSnapshot(entry.name, snapshot), rollouts));
      }
      scanned = { at: now(), sessions, rollouts };  // the rollouts as listed for this scan, for what state() offers from the same Herdr reading
      return sessions;
    })().finally(() => { scanning = null; });
    return scanning;
  }


  // With the store API on, Herdr is not read on a timer: storeapi/herdr-watch.js holds its panes from events.subscribe (and a reconcile read a
  // minute), and the pane of a session is the store's live binding when there is one (S1's identity: a liveness-checked fact), else what
  // Herdr says. The same checks as always (checkSessions) then run, but only when the panes or the bindings changed, not at each poll.
  let watchStarted = null;
  let watched = null;
  const ensureWatch = () => (watchStarted || (watchStarted = paneWatch.start().catch(() => {})));

  function bindingPanes() {
    const found = new Map();
    if (!storeApi) return found;
    try { for (const binding of storeApi.store.liveBindings()) found.set(binding.herdr_session + '|' + binding.pane_id, binding); } catch { /* no store: Herdr alone says */ }
    return found;
  }

  async function scanFromWatch(fresh) {
    await ensureWatch();
    if (fresh) await paneWatch.reconcile();
    const bindings = bindingPanes();
    const key = paneWatch.version + '|' + [...bindings.values()].map((b) => b.herdr_session + b.pane_id + b.session_id).sort().join(',');
    if (watched && watched.key === key && !fresh) { scanned = { at: now(), sessions: watched.sessions, rollouts: rolloutsOnce() }; return watched.sessions; }
    const rollouts = rolloutsOnce();
    const sessions = [];
    for (const raw of paneWatch.sessions()) {
      const session = { name: raw.name, focused: raw.focused, panes: raw.panes.map((pane) => ({ pane_id: pane.pane_id, session_id: pane.session_id, agent: pane.agent, status: pane.status, label: pane.label })) };
      for (const pane of session.panes) {
        const binding = bindings.get(session.name + '|' + pane.pane_id);
        if (binding && (!raw.life || !binding.life || raw.life === binding.life)) pane.session_id = binding.session_id;
      }
      sessions.push(await checkSessions(session, rollouts));
    }
    watched = { key, sessions };
    scanned = { at: now(), sessions, rollouts };
    return sessions;
  }

  // pid -> session id of every running Claude Code process, from the record each keeps in
  // <its config folder>/sessions (it follows /clear and --resume): ~/.claude's and every other config folder's.
  function runningClaude() {
    return runningClaudeSessions(claudeSessionDirs());
  }

  // The Copilot process in the pane's foreground, or null.
  function copilotProcess(processInfo) {
    const processes = Array.isArray(processInfo && processInfo.foreground_processes) ? processInfo.foreground_processes : [];
    return processes.find((item) => {
      if (!item || !Number.isInteger(item.pid)) return false;
      const command = String(item.command || item.cmdline || '').split(/\s+/)[0];
      return path.basename(String(item.argv0 || '')) === 'copilot' || path.basename(command) === 'copilot';
    }) || null;
  }

  // A Copilot process writes `<time> [INFO] Registering foreground session: <id>` to its own log when it starts on a session and again
  // at each /resume and /new, so the newest such line names the session its pane shows. That log is rotated at 10 MB into
  // process-<start>-<pid>.1.log (and fills thousands of lines a minute in a fault of some builds), so the line can end up in the
  // rotated file or be gone. So every file of the process is read, the newest line any look saw is kept, and it is written to
  // out/copilot-panes.json (a process's key is its start time and pid), which the next look here or in build_prototype.py reads when
  // the logs no longer say. Each look reads only what a log gained since the last one (and a line the last look ended in the middle of, whole).
  const copilotScans = new Map();
  const copilotSeen = new Map();
  const copilotPanesFile = () => path.join(outDir, 'copilot-panes.json');
  function copilotLogMarker(file) {
    let stat;
    try { stat = fs.statSync(file); } catch { return null; }
    const size = stat.size;
    let [inode, done, found] = copilotScans.get(file) || [stat.ino, 0, null];
    if (inode !== stat.ino || size < done) { done = 0; found = null; }  // a rotation put another file at this name: read it from its start
    if (size > done) {
      const start = Math.max(0, done - 160, size - COPILOT_LOG_READ_MAX);
      let text;
      try {
        const handle = fs.openSync(file, 'r');
        try {
          const buffer = Buffer.alloc(size - start);
          const read = fs.readSync(handle, buffer, 0, buffer.length, start);
          text = buffer.subarray(0, read).toString('latin1');
        } finally { fs.closeSync(handle); }
      } catch { return found; }
      for (const match of text.matchAll(COPILOT_REGISTERED_RE)) {
        const marker = [match[1], match[2]];
        if (!found || marker[0] + marker[1] >= found[0] + found[1]) found = marker;
      }
      copilotScans.set(file, [stat.ino, size, found]);
    }
    return found;
  }

  const copilotPanesRead = () => { try { const value = parseJson(fs.readFileSync(copilotPanesFile(), 'utf8')); return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; } catch { return {}; } };

  function copilotPanesRemember(key, marker) {
    const cutoff = now() - COPILOT_PANES_KEEP_DAYS * 86400 * 1000;
    const kept = {};
    for (const [k, v] of Object.entries(copilotPanesRead())) if (v && typeof v === 'object' && Number(k.split('-')[0]) >= cutoff) kept[k] = v;
    kept[key] = { at: marker[0], session: marker[1] };
    try {
      fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
      const partial = copilotPanesFile() + '.' + process.pid + '.partial';
      fs.writeFileSync(partial, JSON.stringify(kept, null, 1), { mode: 0o600 });
      fs.renameSync(partial, copilotPanesFile());
    } catch { /* the next look writes it again */ }
  }

  // The session the pane's Copilot process shows: the newest session its logs or an earlier look registered for it, else the session
  // folder holding its inuse.<pid>.lock when that has a conversation (the lock names only the session the process started on, so a
  // /resume leaves it behind). Null when neither says: never guessed from a label or a folder.
  function copilotSessionForProcessInfo(processInfo) {
    const proc = copilotProcess(processInfo);
    if (!proc) return null;
    const logsDir = path.join(copilotHomeDir, 'logs');
    const state = path.join(copilotHomeDir, 'session-state');
    let files = [];
    try {
      files = fs.readdirSync(logsDir)
        .map((name) => ({ name, match: /^process-(\d+)-(\d+)(?:\.\d+)?\.log$/.exec(name) }))
        .filter((entry) => entry.match && Number(entry.match[2]) === proc.pid)
        .map((entry) => ({ start: Number(entry.match[1]), file: path.join(logsDir, entry.name) }));
    } catch { /* no logs folder */ }
    if (files.length) {  // the process that runs now is the latest one to have had this pid
      const started = Math.max(...files.map((entry) => entry.start));
      const key = started + '-' + proc.pid;
      let known = copilotSeen.get(key) || null;
      if (!known) {
        const stored = copilotPanesRead()[key];
        if (stored && typeof stored.at === 'string' && typeof stored.session === 'string') known = [stored.at, stored.session];
      }
      let best = known;
      for (const entry of files) {
        const marker = entry.start === started ? copilotLogMarker(entry.file) : null;
        if (marker && (!best || marker[0] + marker[1] > best[0] + best[1])) best = marker;
      }
      if (best && (!known || best[0] !== known[0] || best[1] !== known[1])) copilotPanesRemember(key, best);
      if (best) {
        copilotSeen.set(key, best);
        if (SESSION_ID_RE.test(best[1]) && fs.existsSync(path.join(state, best[1]))) return best[1];
      }
    }
    let locks = [];
    try {
      locks = fs.readdirSync(state)
        .filter((name) => SESSION_ID_RE.test(name) && fs.existsSync(path.join(state, name, COPILOT_EVENTS)) && fs.existsSync(path.join(state, name, 'inuse.' + proc.pid + '.lock')))
        .map((name) => ({ name, at: mtimeMs(path.join(state, name, 'inuse.' + proc.pid + '.lock')) }))
        .sort((a, b) => b.at - a.at);
    } catch { /* no session folder */ }
    return locks.length ? locks[0].name : null;
  }

  function codexProcess(processInfo) {
    const processes = Array.isArray(processInfo && processInfo.foreground_processes) ? processInfo.foreground_processes : [];
    return processes.find((item) => {
      const argv0 = path.basename(String(item && item.argv0 || ''));
      const command = String(item && (item.command || item.cmdline) || '');
      return argv0 === 'codex' || /(?:^|[\s/])codex(?:$|[\s/])/.test(command);
    }) || null;
  }

  function codexSessionForProcessInfo(processInfo, claimed = null, rollouts = codexRollouts) {
    const process = codexProcess(processInfo);
    if (!process) return null;
    const cwd = process.cwd || (processInfo && processInfo.cwd);
    if (typeof cwd !== 'string' || !cwd) return null;
    let realCwd;
    try { realCwd = fs.realpathSync.native(cwd); } catch { realCwd = path.resolve(cwd); }
    const match = rollouts().find((entry) => entry.cwd === realCwd);
    if (match) return match.session;
    return null;
  }

  // Herdr keeps the session id it was first told even when Claude is restarted in the same
  // pane (Firstmate swaps a worker's model that way), and it can keep the id of an agent that
  // has exited, the pane then naming no agent at all. A pane with such an id that no running
  // Claude holds takes the session of its foreground Claude process, or none when the pane is
  // back at its shell. Read-only: `herdr pane process-info`, asked only for such panes.
  async function checkSessions(session, rollouts = rolloutsOnce()) {
    const running = runningClaude();
    const hasCodex = session.panes.some((pane) => pane.agent === 'codex');
    const hasCopilot = session.panes.some((pane) => pane.agent === 'copilot');
    if (!running.size && !hasCodex && !hasCopilot) return session;
    const held = new Set(running.values());
    for (const pane of session.panes) {
      if (pane.agent === 'codex') {
        const result = await runner(herdrBin, ['--session', session.name, 'pane', 'process-info', '--pane', pane.pane_id], { env: runEnv(), timeoutMs: 5000 });
        const info = ((((result.code === 0 && parseJson(result.stdout)) || {}).result) || {}).process_info;
        pane.session_id = codexSessionForProcessInfo(info, pane.session_id, rollouts);
        continue;
      }
      if (pane.agent === 'copilot') {
        // Herdr names no session for a Copilot pane.
        const result = await runner(herdrBin, ['--session', session.name, 'pane', 'process-info', '--pane', pane.pane_id], { env: runEnv(), timeoutMs: 5000 });
        const info = ((((result.code === 0 && parseJson(result.stdout)) || {}).result) || {}).process_info;
        pane.session_id = copilotSessionForProcessInfo(info);
        continue;
      }
      const retained = !pane.agent && pane.session_id;
      if ((pane.agent !== 'claude' && !retained) || held.has(pane.session_id)) continue;
      const result = await runner(herdrBin, ['--session', session.name, 'pane', 'process-info', '--pane', pane.pane_id], { env: runEnv(), timeoutMs: 5000 });
      const info = ((((result.code === 0 && parseJson(result.stdout)) || {}).result) || {}).process_info;
      if (!info) continue;
      const processes = Array.isArray(info.foreground_processes) ? info.foreground_processes : [];
      const actual = processes.map((process) => running.get(process.pid)).find(Boolean);
      if (actual) pane.session_id = actual;
      else if (!processes.some((process) => process.argv0 === 'claude')) pane.session_id = null;
    }
    return session;
  }

  // The pane Herdr focused most recently. focus.seq moves whenever the focused pane,
  // or the agent session running in it, changes in any Herdr session. Before any
  // change is seen, the only running Herdr session's focus is taken.
  function trackFocus(sessions) {
    for (const session of sessions) {
      const pane = session.panes.find((p) => p.pane_id === session.focused);
      const key = session.focused + '|' + (pane ? pane.session_id : '');
      const before = focusSeen.get(session.name);
      focusSeen.set(session.name, key);
      if (before !== undefined && before !== key) { focus.herdr = session.name; focus.seq += 1; }
    }
    if (focus.herdr === null && sessions.length === 1) { focus.herdr = sessions[0].name; focus.seq += 1; }
    const session = sessions.find((s) => s.name === focus.herdr);
    const pane = session && session.panes.find((p) => p.pane_id === session.focused);
    if (!pane) return null;
    return { seq: focus.seq, herdr: session.name, label: pane.label, session_id: pane.session_id };
  }

  // ----------------------------------------------------------------- rebuilds

  // The reader.py that stays running, started on its first request; one that cannot take a request leaves it to a fresh reader.py.
  // It is kept (not ended after its idle ten minutes) while a page has been seen in the last WARM_MS, so a tab picked after a quiet spell does not start a cold one.
  const readerWorker = worker ? workerLib.create({ command: pythonBin, args: ['-I', readerScript, 'worker'], cwd: root, env: runEnv(), timeoutMs: 60000, now, keepWarm: () => lastSeen > 0 && now() - lastSeen < WARM_MS }) : null;

  // The offline copy's builds, for its page's Sync: sync.py in a process of its own, as the LaunchAgent would run it. PMOS_READER_COPY_ARGS
  // gives the build the options a build run by hand would have (--panes open, --no-workspace).
  const copySync = copySyncLib.create({ root, outDir, runner, env: runEnv(), pythonBin, now, args: (env.PMOS_READER_COPY_ARGS || '').split(/\s+/).filter(Boolean) });
  const copyNamed = (value) => {
    try { copySync.status(value); } catch { throw new RequestError('Name the copy: bucket or hosted.'); }
    return value;
  };

  async function execReader(args) {
    if (readerWorker) {
      const result = await readerWorker.run(args);
      if (!result.crashed) return result;
    }
    return runner(pythonBin, ['-I', readerScript, ...args], { env: runEnv(), cwd: root, timeoutMs: 60000, maxBytes: 64 * 1024 });
  }

  function runReader(args, adding = null) {
    build.lastStart = now();
    const done = execReader(args).then((result) => {
      if (result.code === 0) { build.error = null; build.failedAt = 0; }
      else {
        build.failedAt = now();
        build.rebuiltFor = 0;  // a failed rebuild is tried again once its hold is over, whatever the logs do meanwhile
        const lines = (result.stderr || result.stdout || '').trim().split('\n');
        build.error = result.timedOut ? 'The rebuild took over a minute and was stopped.' : (lines[lines.length - 1] || 'The rebuild failed.').slice(0, 200);
        if (adding) build.failedAdds.set(adding, now());
      }
      return result;
    }).finally(() => { build.running = null; build.lastEnd = now(); afterBuild(); });
    build.running = { args: args[0], adding, done };
    return done;
  }

  // Whether a listed log was written after the page was built (the page's stamp is when its build began, so a turn written
  // while it ran counts), and after the write the last rebuild this started was for: a log dated in the future, or one that stays
  // newer than every build for another reason, is rebuilt for once, not in a loop.
  function logsNewer(ids) {
    const built = stamp('prototype.stamp');
    build.newest = Math.max(0, ...ids.map((id) => { const file = logPath(id); return file ? mtimeMs(file) : 0; }));
    return built === null || (build.newest > built * 1000 && build.newest > build.rebuiltFor);
  }

  // List the session a listed pane moved on to (see paneRuns) once it has a log. True when it started the rebuild that lists it.
  function adoptCleared(ids) {
    for (const [id, seen] of cleared) {
      if (ids.includes(id) || now() - seen.at > CLEARED_GIVE_UP_MS) { cleared.delete(id); continue; }
      if (build.running || !logPath(id)) continue;  // no log yet: looked at again with the next look at the panes or the logs
      const failed = build.failedAdds.get(id);
      if (failed && now() - failed <= RETRY_AFTER_FAILURE_MS) continue;
      if (waitForTurn()) return true;
      runReader(['adopt', id], id);
      return true;
    }
    return false;
  }

  // Rebuild when a listed session's log is newer than the page or its pane closed, or add the focused session.
  function maybeRebuild(ids, focused, follow) {
    if (build.running || now() - build.lastEnd < REBUILD_GAP_MS) return;
    if (follow && focused && focused.session_id && !ids.includes(focused.session_id) && logPath(focused.session_id)) {
      const failed = build.failedAdds.get(focused.session_id);
      if (!failed || now() - failed > RETRY_AFTER_FAILURE_MS) { runReader(['follow', focused.session_id], focused.session_id); return; }
    }
    if (build.failedAt && now() - build.failedAt < RETRY_AFTER_FAILURE_MS) return;
    if (adoptCleared(ids)) return;
    if ((ids.length || build.paneClosed) && (build.paneClosed || logsNewer(ids))) {
      if (waitForTurn()) return;
      build.paneClosed = false; build.rebuiltFor = build.newest; runReader(['rebuild']);
    }
  }

  // Whether the last rebuild started too lately for another (rebuildEveryMs); if so, the sweep is asked to look again when it is over.
  function waitForTurn() {
    const wait = build.lastStart + rebuildEveryMs - now();
    if (wait <= 0) return false;
    if (sweepTimer) lookAgainIn(wait);
    return true;
  }

  // ----------------------------------------------------------------- watching

  // While a page is open (it polled, or waits on `events`) the logs of the listed sessions are watched here, and a change
  // starts the rebuild at once. Nothing is watched, and nothing rebuilt, with no page open. The folders are watched for the
  // file system's notice of a write; the sweep is the check that does not depend on it, and what runs after each build.
  let lastSeen = 0;
  let sweepTimer = null;
  let afterTimer = null;
  let sweepQueued = false;
  const folders = new Map();
  const waiters = new Set();

  const buildInfo = () => ({ running: Boolean(build.running), adding: build.running ? build.running.adding : null, error: build.error });
  const stampsNow = () => ({ reader: stamp('prototype.stamp'), sheet: stamp('questionnaire.stamp') });
  const isNewer = (have, current) => (Number.isFinite(have.reader) && current.reader !== null && current.reader > have.reader)
    || (Number.isFinite(have.sheet) && current.sheet !== null && current.sheet > have.sheet);

  function sweepSoon() {
    if (sweepQueued) return;
    sweepQueued = true;
    setImmediate(() => { sweepQueued = false; sweep(); });
  }

  function syncFolders() {
    const want = new Set([outDir]);
    for (const id of listed()) { const file = logPath(id); if (file) want.add(path.dirname(file)); }
    for (const [dir, watcher] of folders) if (!want.has(dir)) { watcher.close(); folders.delete(dir); }
    for (const dir of want) {
      if (folders.has(dir)) continue;
      try {
        // In out/ only the stamps and the list say anything (a build writes many other files).
        const watcher = fs.watch(dir, { persistent: false }, (event, name) => { if (dir !== outDir || /stamp$|^sessions\.txt$/.test(name || '')) sweepSoon(); });
        watcher.on('error', () => { watcher.close(); if (folders.get(dir) === watcher) folders.delete(dir); });
        folders.set(dir, watcher);
      } catch { /* the sweep covers a folder that cannot be watched */ }
    }
  }

  function sweep() {
    if (!watch) return;
    if (now() - lastSeen > PRESENCE_MS && !waiters.size) { stopWatching(); return; }
    syncFolders();
    if (!build.running && now() - build.lastEnd >= REBUILD_GAP_MS && !(build.failedAt && now() - build.failedAt < RETRY_AFTER_FAILURE_MS)) {
      const ids = listed();
      if (adoptCleared(ids)) { /* the new session of a cleared pane is being listed */ }
      else if (ids.length && logsNewer(ids) && !waitForTurn()) { build.rebuiltFor = build.newest; runReader(['rebuild']); }
    }
    answerWaiters();
  }

  function startWatching() {
    if (sweepTimer) return;
    sweepTimer = setInterval(sweep, sweepMs);
    if (sweepTimer.unref) sweepTimer.unref();
    sweepSoon();
  }

  function stopWatching() {
    clearInterval(sweepTimer);
    clearTimeout(afterTimer);
    sweepTimer = afterTimer = null;
    for (const watcher of folders.values()) watcher.close();
    folders.clear();
  }

  // A page is there: it polled or it waits.
  function seen() {
    lastSeen = now();
    if (watch) startWatching();
  }

  // After a build: waiting pages learn of the stamp it left, and a log written meanwhile is looked at once the pause is over.
  function afterBuild() {
    answerWaiters();
    if (!sweepTimer) return;
    lookAgainIn(REBUILD_GAP_MS);
  }

  // The sweep once more in <ms>, in place of one that was set for later (a sweep that finds a write to rebuild for, and must wait, sets this).
  function lookAgainIn(ms) {
    clearTimeout(afterTimer);
    afterTimer = setTimeout(sweep, Math.max(ms, 1));
    if (afterTimer.unref) afterTimer.unref();
  }

  function finishWaiter(waiter) {
    if (!waiters.delete(waiter)) return;
    clearTimeout(waiter.timer);
    send(waiter.res, 200, { status: 'ok', stamps: stampsNow(), build: buildInfo() });
  }

  function answerWaiters() {
    if (!waiters.size) return;
    const current = stampsNow();
    for (const waiter of [...waiters]) if (isNewer(waiter.have, current)) finishWaiter(waiter);
  }

  // events: answers at once when a build newer than the page's is there, else when one is published, else after `wait`.
  function events(res, query) {
    const stampOf = (name) => (query.get(name) === null || query.get(name) === '' ? NaN : Number(query.get(name)));
    const have = { reader: stampOf('reader'), sheet: stampOf('sheet') };
    const wait = Math.min(Math.max(Number(query.get('wait')) || 0, 0), MAX_WAIT_MS);
    seen();
    if (!wait || isNewer(have, stampsNow())) { send(res, 200, { status: 'ok', stamps: stampsNow(), build: buildInfo() }); return; }
    const waiter = { have, res, timer: null };
    waiter.timer = setTimeout(() => finishWaiter(waiter), wait);
    waiters.add(waiter);
    res.on('close', () => { if (waiters.delete(waiter)) clearTimeout(waiter.timer); });
    if (watch) sweepSoon();
  }

  // Ends what runs for the server: the waiting pages, the watching and the worker.
  function close() {
    for (const waiter of [...waiters]) finishWaiter(waiter);
    permissions.close();
    stopWatching();
    if (readerWorker) readerWorker.stop();
    if (storeApi) storeApi.close();
    if (paneWatch) paneWatch.stop();
  }

  // A listed conversation whose pane now runs a session that is not listed (a /clear, a /new, an agent started again in the pane), by the
  // new session's id: when it was first seen, and the session the pane ran before. The new session is listed (reader.py adopt) as soon as its
  // log exists, which can be after the pane already runs it (the first message after a clear writes it), and nothing else may be about to
  // rebuild: a quiet fleet writes no other log. Followed by the look in maybeRebuild and the sweep (adoptCleared).
  const paneRuns = new Map();  // `${Herdr session}|${pane id}` -> the session last seen running there
  const cleared = new Map();
  const CLEARED_GIVE_UP_MS = 30 * 60 * 1000;

  function notePaneChanges(ids, sessions) {
    if (!sessions.length) return;  // Herdr not answering says nothing about panes
    const live = new Set(sessions.flatMap((session) => session.panes.map((pane) => pane.session_id)));
    const byHand = closedByHand();
    for (const session of sessions) {
      for (const pane of session.panes) {
        if (!pane.session_id) continue;  // an agent between sessions keeps what it ran before
        const key = session.name + '|' + pane.pane_id;
        const before = paneRuns.get(key);
        paneRuns.set(key, pane.session_id);
        if (before && before !== pane.session_id && ids.includes(before) && !ids.includes(pane.session_id) && !byHand.includes(pane.session_id)) {
          cleared.set(pane.session_id, { at: now(), from: before });
        }
      }
    }
    for (const id of seenLive) {
      if (live.has(id)) continue;
      seenLive.delete(id);
      if (ids.includes(id)) build.paneClosed = true;
    }
    for (const id of ids) if (live.has(id)) seenLive.add(id);
    // A dropped session that runs in a pane again is listed again by the next rebuild.
    if (dropped().some((id) => live.has(id))) build.paneClosed = true;
  }

  // What every call that a page or a client polls does first: it is there (the logs are watched while it is), Herdr is read (at most once
  // in SCAN_TTL_MS), pane changes and focus are noted, and a rebuild is started when a listed log or pane says one is due.
  async function tend(follow, boot = false) {
    seen();
    const ids = listed();
    const sessions = await scan({ maxAge: boot ? BOOT_SCAN_MAX_AGE_MS : 0 });
    const focused = trackFocus(sessions);
    notePaneChanges(ids, sessions);
    // A page built after the last failed rebuild (by `reader.py add`, say) ends that failure:
    // its banner and its hold on rebuilds.
    const built = stamp('prototype.stamp');
    if (build.failedAt && built !== null && built * 1000 > build.failedAt) { build.error = null; build.failedAt = 0; }
    maybeRebuild(ids, focused, follow);
    return { ids, sessions, focused };
  }

  async function state(follow, boot = false) {
    const { ids, sessions, focused } = await tend(follow, boot);
    const panes = {};
    for (const session of sessions) {
      for (const pane of session.panes) {
        if (pane.session_id && ids.includes(pane.session_id)) panes[pane.session_id] = { label: pane.label, status: pane.status, herdr: session.name };
      }
    }
    return {
      stamps: { reader: stamp('prototype.stamp'), sheet: stamp('questionnaire.stamp'), pins: pins.read().rev, stars: stars.read().rev, flags: sheetFlags.read().rev, hidden: hidden.read().rev },
      focus: focused && {
        ...focused,
        listed: focused.session_id ? ids.includes(focused.session_id) : false,
        readable: focused.session_id ? Boolean(logPath(focused.session_id)) : false,
      },
      panes,
      ...(permissions.enabled ? { permissions: { rev: permissions.rev(), open: permissions.open() } } : {}),
      tabs: unlistedPanes(sessions, ids, (scanned && scanned.sessions === sessions && scanned.rollouts) || rolloutsOnce()),
      build: buildInfo(),
    };
  }

  // ------------------------------------------------------------------- open asks

  // The conversations that ask you something, for a native client's rows (Conn's agents): one entry for each live Herdr pane whose
  // conversation has an open ask, the newest ask of each. Nothing is worked out here. The glance feed (out/glance.json, written by the
  // page build from the same turns, rules and answer sheets the page's "Needs you" chips use: build_prototype.conversation_summary) says
  // which conversations ask and what; Herdr, as the state route reads it, says which pane runs each. The feed is parsed again only when
  // its file changed. `older` is the one thing that depends on the time of the call, so it is not in the feed.
  const OLDER_THAN_MS = 24 * 60 * 60 * 1000;
  const MAX_ASK_LINES = 3;
  let glanceRead = { key: null, feed: null };

  function readGlance() {
    const file = path.join(outDir, 'glance.json');
    let stat;
    try { stat = fs.statSync(file); } catch { return null; }
    const key = stat.mtimeMs + ':' + stat.size + ':' + stat.ino;
    if (glanceRead.key !== key) {
      let feed = null;
      try { feed = parseJson(fs.readFileSync(file, 'utf8')); } catch { feed = null; }
      if (!(feed && feed.version === 1 && Array.isArray(feed.conversations))) return null;  // a format this module does not know is ignored
      glanceRead = { key, feed };
    }
    return glanceRead.feed;
  }

  const strings = (value, limit) => (Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item).slice(0, limit) : []);

  async function openAsks() {
    const { sessions } = await tend(false);
    const feed = readGlance();
    if (!feed) throw new RequestError('Not built yet.', 404, 'not_built');
    // The pane running each session, as Herdr says now: a pane that has closed is no longer a row to put an ask on.
    const running = new Map();
    for (const herdrSession of sessions) {
      for (const pane of herdrSession.panes) if (pane.session_id && !running.has(pane.session_id)) running.set(pane.session_id, { pane_id: pane.pane_id, herdr: herdrSession.name });
    }
    const at = now();
    const asks = [];
    for (const conversation of feed.conversations) {
      const ask = conversation && conversation.ask;
      if (!(ask && Number.isFinite(ask.at) && conversation.open_asks > 0 && typeof conversation.id === 'string')) continue;
      // Herdr names the session its pane runs now, which may be any of the conversation's sessions (a /clear starts a new one).
      const pane = [conversation.id, ...[...(Array.isArray(conversation.ids) ? conversation.ids : [])].reverse()].map((id) => running.get(id)).find(Boolean);
      if (!pane) continue;
      asks.push({
        pane_id: pane.pane_id, herdr: pane.herdr, session: conversation.id, message: typeof ask.uid === 'string' && ask.uid ? ask.uid : null,
        lines: strings(ask.lines, MAX_ASK_LINES), at: new Date(ask.at * 1000).toISOString(), tags: strings(ask.tags, 8), older: at - ask.at * 1000 > OLDER_THAN_MS,
      });
    }
    // Newest first, and one for each pane: a pane that two listed conversations claim (a /clear whose old conversation is still listed) keeps its newest.
    asks.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
    const taken = new Set();
    const one = asks.filter((ask) => { const key = ask.herdr + '|' + ask.pane_id; if (taken.has(key)) return false; taken.add(key); return true; });
    return { generated_at: new Date(at).toISOString(), as_of: Number.isFinite(feed.as_of) ? new Date(feed.as_of * 1000).toISOString() : null, asks: one };
  }

  // ------------------------------------------------------------------- sync

  // The live Herdr tabs the reading list lacks, for the picker's "Herdr tabs" group: each pane running Claude, Codex or Copilot whose session has a
  // log to read, in the order Herdr lists them. One a person took off the list is offered too: choosing it is a new yes. This runs on every state
  // poll, so it asks of each pane only what its agent's log needs (a Claude log is a look in the project folders; a Codex rollout is in the list the
  // scan already made; a Copilot log is a folder named for the session), and walks no sessions folder of its own.
  function unlistedPanes(sessions, ids, rollouts) {
    const have = new Set(ids);
    const found = [];
    for (const session of sessions) {
      for (const pane of session.panes) {
        const id = pane.session_id;
        if (!id || have.has(id)) continue;
        const readable = pane.agent === 'claude' ? Boolean(claudeLogPath(id))
          : pane.agent === 'codex' || !pane.agent ? rollouts().some((entry) => entry.session === id)
            : pane.agent === 'copilot' ? Boolean(copilotLog(id)) : false;
        if (!readable) continue;
        have.add(id);
        found.push({ session_id: id, label: pane.label, status: pane.status, herdr: session.name, agent: pane.agent });
      }
    }
    return found;
  }

  // The sessions running in a Herdr pane with Claude, Codex or Copilot that the reading list lacks and has a log to read, and that no
  // person took off the list. Only listing them changes the list; the panes are not touched.
  function unlistedLive(sessions) {
    const skip = new Set([...listed(), ...closedByHand()]);
    const found = [];
    const rollouts = rolloutsOnce();
    for (const session of sessions) {
      for (const pane of session.panes) {
        const id = pane.session_id;
        const codex = id && rollouts().some((entry) => entry.session === id);
        if ((pane.agent === 'claude' || pane.agent === 'codex' || pane.agent === 'copilot' || codex) && id && !skip.has(id) && logPath(id)) { skip.add(id); found.push(id); }
      }
    }
    return found;
  }

  // What the Sync button asks for: Herdr is read again now (not from the last scan), every live Claude, Codex or Copilot pane's session
  // not yet listed is listed (reader.py adopt, as follow lists the focused one, so /clear joins and labels work the
  // same), the pages are rebuilt from the session logs and the fleet records whether or not a log looks newer, and
  // the answer is state's, once it is done. That is the same read-only rebuild a changed log starts, so the reading
  // list, each session's live or ended state and every listed session's newest turns are all taken again; it waits
  // for one already running.
  async function sync(body) {
    for (const key of Object.keys(body)) if (key !== 'follow') throw new RequestError('Unknown field.');
    if (body.follow !== undefined && typeof body.follow !== 'boolean') throw new RequestError('Invalid follow.');
    while (build.running) await build.running.done;
    const sessions = await scan({ fresh: true });
    notePaneChanges(listed(), sessions);
    const adopt = unlistedLive(sessions);
    const result = await runReader(adopt.length ? ['adopt', ...adopt] : ['rebuild']);
    if (result.code !== 0) throw new RequestError(build.error || 'The rebuild failed.', 502, 'rebuild_failed');
    build.paneClosed = false;
    return { synced: now() / 1000, ...(await state(body.follow === true)) };
  }

  // The Re-render button of a marked reply: a rebuild of every page now, whether or not a log looks newer. It waits for one already running.
  async function rerender(body) {
    if (Object.keys(body).length) throw new RequestError('Unknown field.');
    while (build.running) await build.running.done;
    const result = await runReader(['rebuild']);
    if (result.code !== 0) throw new RequestError(build.error || 'The rebuild failed.', 502, 'rebuild_failed');
    return { rendered: now() / 1000, stamp: stamp('prototype.stamp'), sheet: stamp('questionnaire.stamp') };
  }

  // ------------------------------------------------------------ reopen, close

  // Reopen lists a session to read again, even though its pane has closed; close takes one
  // off the list. Each waits for a running rebuild, runs its own, and answers when the page is built.
  async function changeList(command, body) {
    for (const key of Object.keys(body)) if (key !== 'session_id') throw new RequestError('Unknown field.');
    const sessionId = body.session_id;
    if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) throw new RequestError('Invalid session id.');
    if (command === 'reopen' && !logPath(sessionId)) throw new RequestError('That session has no log to read.', 404, 'no_log');
    if (command === 'close' && !listed().includes(sessionId)) throw new RequestError('That session is not on the reading list.', 409, 'not_listed');
    while (build.running) await build.running.done;
    const result = await runReader([command, sessionId]);
    if (result.code !== 0) throw new RequestError(build.error || 'The rebuild failed.', 502, 'rebuild_failed');
    return { stamp: stamp('prototype.stamp') };
  }

  // The picker's "Herdr tabs": list one live tab's session and build the page with it now. It is a reopen for a pane that runs: the same wait
  // for a running rebuild, then reader.py tab, which leaves the closed-pane sweep and the chain walk of every other listed session to the next
  // ordinary rebuild (they are most of the time a rebuild takes, and a new tab changes neither). Answers when the page is built.
  async function addTab(body) {
    for (const key of Object.keys(body)) if (key !== 'session_id') throw new RequestError('Unknown field.');
    const sessionId = body.session_id;
    if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) throw new RequestError('Invalid session id.');
    if (!logPath(sessionId)) throw new RequestError('That session has no log to read.', 404, 'no_log');
    if (!listed().includes(sessionId)) {
      while (build.running) await build.running.done;
      build.failedAdds.delete(sessionId);
      const result = await runReader(['tab', sessionId], sessionId);
      if (result.code !== 0) throw new RequestError(build.error || 'The rebuild failed.', 502, 'rebuild_failed');
    }
    return { stamp: stamp('prototype.stamp') };
  }

  // -------------------------------------------------------------------- send

  // Herdr's guide: a retained agent identity (even idle or done) does not mean the agent is in
  // the foreground; after Ctrl+Z a shell is, and each line sent would run as a command. So the
  // The pane's foreground must hold the named harness running this very session. Claude is
  // checked by its ~/.claude/sessions record; Codex is checked by its native rollout cwd.
  // Read-only: `herdr pane process-info`.
  async function checkForeground(pane, sessionId) {
    const result = await runner(herdrBin, ['--session', pane.herdr, 'pane', 'process-info', '--pane', pane.pane_id], { env: runEnv(), timeoutMs: 5000 });
    const info = ((((result.code === 0 && parseJson(result.stdout)) || {}).result) || {}).process_info;
    if (!info) throw new RequestError('Herdr could not say what runs in the pane, so nothing was sent. Check the pane first.', 502, 'herdr_failed');
    if (pane.agent === 'codex') {
      const actual = codexSessionForProcessInfo(info, pane.session_id);
      if (actual === sessionId) return;
      if (actual) throw new RequestError('The pane now runs another Codex session, so nothing was sent. Reload the page.', 409, 'other_session');
      throw new RequestError('The Codex agent is not in the foreground of its pane, so nothing was sent. Check the pane first.', 409, 'agent_not_foreground');
    }
    const processes = Array.isArray(info.foreground_processes) ? info.foreground_processes : [];
    const running = runningClaude();
    const held = processes.map((process) => running.get(process.pid)).filter(Boolean);
    if (held.includes(sessionId)) return;
    if (held.length) throw new RequestError('The pane now runs another Claude session, so nothing was sent. Reload the page.', 409, 'other_session');
    if (processes.some((process) => process.argv0 === 'claude')) return;
    throw new RequestError('The agent is not in the foreground of its pane (it may be suspended to a shell), so nothing was sent. Check the pane first.', 409, 'agent_not_foreground');
  }

  // ------------------------------------------------------------------ photos

  // out/uploads/, made owner-only (0700) every time it is used, and its real path (the one a person or an agent can open).
  function uploadsDir() {
    const dir = path.join(outDir, UPLOADS);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    return fs.realpathSync(dir);
  }

  // Before a photo is saved: the folder drops what is old (a photo after 30 days, a leftover conversion file after an hour) and
  // refuses the photo when what stays and it would pass 1 GB. A person clears space by deleting files in it; nothing else does.
  function tidyUploads(dir, incoming) {
    let total = incoming;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const file = path.join(dir, entry.name);
      let stat;
      try { stat = fs.statSync(file); } catch { continue; }
      if (now() - stat.mtimeMs > (entry.name.startsWith('.') ? UPLOAD_TEMP_KEEP_MS : UPLOAD_KEEP_MS)) {
        try { fs.unlinkSync(file); } catch { /* a person or another request got there first */ }
        continue;
      }
      total += stat.size;
    }
    if (total > UPLOADS_FULL_BYTES) throw new RequestError('The laptop\'s photo folder is full (1 GB). Delete old files in setup/transcript-reader/out/uploads, then try again.', 507, 'folder_full');
  }

  // An iPhone's HEIC as JPEG bytes, converted by sips through two short-lived files in the folder, or null when it could not be.
  async function heicToJpeg(bytes, dir) {
    const stem = path.join(dir, '.convert-' + crypto.randomBytes(8).toString('hex'));
    const input = stem + '.heic';
    const output = stem + '.jpg';
    try {
      fs.writeFileSync(input, bytes, { mode: 0o600, flag: 'wx' });
      const result = await runner(sipsBin, ['-s', 'format', 'jpeg', '-s', 'formatOptions', '90', input, '--out', output], { env: runEnv(), timeoutMs: 30000 });
      if (result.code !== 0) return null;
      const converted = fs.readFileSync(output);
      const kind = sniffImage(converted);
      return kind && kind.ext === '.jpg' ? converted : null;
    } catch { return null; } finally {
      for (const file of [input, output]) { try { fs.unlinkSync(file); } catch { /* never made */ } }
    }
  }

  // What the page's upload asks: one photo, checked by its bytes and saved under a random name. { id, bytes, type[, converted] }.
  async function uploadPhoto(body) {
    for (const key of Object.keys(body)) if (key !== 'data' && key !== 'name') throw new RequestError('Unknown field.');
    if (typeof body.name !== 'undefined' && typeof body.name !== 'string') throw new RequestError('Invalid name.');
    // The name is only ever shown back in a refusal, never used for the file.
    const label = (body.name || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 60) || 'That file';
    if (typeof body.data !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(body.data)) throw new RequestError(label + ' arrived empty or damaged, so it was not saved.', 400, 'bad_data');
    let bytes = Buffer.from(body.data, 'base64');
    if (bytes.length > MAX_PHOTO_BYTES) throw new RequestError(label + ' is ' + megabytes(bytes.length) + '; a photo can be at most ' + megabytes(MAX_PHOTO_BYTES) + '.', 413, 'too_big');
    let kind = sniffImage(bytes);
    if (!kind) throw new RequestError(label + ' is not a PNG, JPEG, GIF, WebP or HEIC image, so it was not saved.', 415, 'not_image');
    const dir = uploadsDir();
    tidyUploads(dir, bytes.length);
    let converted = false;
    if (kind.heic) {
      const jpeg = await heicToJpeg(bytes, dir);
      if (!jpeg) throw new RequestError(label + ' is a HEIC photo and the laptop could not convert it to JPEG (it uses sips), so it was not saved.', 415, 'heic_failed');
      bytes = jpeg;
      kind = sniffImage(bytes);
      converted = true;
    }
    const name = crypto.randomBytes(16).toString('hex') + kind.ext;
    const file = path.join(dir, name);
    try {
      fs.writeFileSync(file, bytes, { mode: 0o600, flag: 'wx' });
      fs.chmodSync(file, 0o600);
    } catch { throw new RequestError(label + ' could not be saved on the laptop.', 500, 'upload_failed'); }
    return { id: name, bytes: bytes.length, type: kind.type, ...(converted ? { converted: 'heic' } : {}) };
  }

  // The saved photos a send names, as absolute paths, or a RequestError saying why none is typed: each id must be one upload gave
  // (never a path), still a plain file of this folder, and together they stay within the count and the size a message may carry.
  function checkPhotos(value) {
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw new RequestError('Invalid photos.');
    if (value.length > MAX_PHOTOS) throw new RequestError('A message can carry at most ' + MAX_PHOTOS + ' photos.', 413, 'too_many');
    let dir;
    try { dir = fs.realpathSync(path.join(outDir, UPLOADS)); } catch { dir = null; }
    const seen = new Set();
    const files = [];
    let total = 0;
    for (const id of value) {
      if (typeof id !== 'string' || !UPLOAD_NAME_RE.test(id)) throw new RequestError('Invalid photo id.');
      if (seen.has(id)) throw new RequestError('The same photo is listed twice.');
      seen.add(id);
      let stat = null;
      try { stat = dir && fs.lstatSync(path.join(dir, id)); } catch { stat = null; }
      if (!stat || !stat.isFile()) throw new RequestError('A photo is no longer on the laptop, so nothing was sent. Add it again.', 409, 'image_gone');
      total += stat.size;
      files.push(path.join(dir, id));
    }
    if (total > MAX_PHOTOS_BYTES) throw new RequestError('The photos add up to ' + megabytes(total) + '; a message can carry at most ' + megabytes(MAX_PHOTOS_BYTES) + '.', 413, 'too_big');
    return files;
  }

  // The text that goes to the pane: what was typed, then one line for each photo naming its file, as Claude Code is pointed at a picture.
  const withPhotos = (typed, files) => [typed, files.map((file) => 'Attached image: ' + file).join('\n')].filter(Boolean).join('\n\n');

  // The shadow store (S1) records its own live binding for the pane beside this check's result, once per Send, to prove the store against the
  // foreground process. Off unless PMOS_READER_STORE_RECORDER names store/reader_store.py. Fire and forget: it never delays, changes or refuses a send.
  function recordSendCheck(pane, sessionId, result) {
    const recorder = env.PMOS_READER_STORE_RECORDER;
    if (!recorder) return;
    try {
      Promise.resolve(runner(pythonBin, ['-I', recorder, 'record-send', '--herdr-session', pane.herdr, '--pane', pane.pane_id, '--session', sessionId, '--result', result],
        { env: runEnv(), timeoutMs: 5000 })).catch(() => {});
    } catch { /* a recorder that cannot start is not a reason to refuse a send */ }
  }

  async function sendPrompt(body) {
    for (const key of Object.keys(body)) if (key !== 'session_id' && key !== 'text' && key !== 'images') throw new RequestError('Unknown field.');
    const sessionId = body.session_id;
    if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) throw new RequestError('Invalid session id.');
    const files = checkPhotos(body.images);
    // With photos the words may be none; a slash command goes alone, so the agent still reads it as a command.
    const typed = files.length && (body.text === undefined || (typeof body.text === 'string' && !body.text.trim())) ? '' : checkText(body.text);
    if (files.length && typed.startsWith('/')) throw new RequestError('A command goes on its own, so it cannot carry photos.', 400, 'command_with_photos');
    const text = withPhotos(typed, files);
    if (!(sendable ? sendable() : listed()).includes(sessionId)) throw new RequestError('That session is not on the reading list.', 409, 'not_listed');
    // A Copilot session is read only. This is known from its log, so nothing is asked of Herdr and no key reaches a pane.
    if (isCopilotSession(sessionId)) throw new RequestError(COPILOT_SEND_REFUSAL, 409, 'copilot_send_unsupported');
    const sessions = await scan({ fresh: true });
    const matches = sessions.flatMap((session) => session.panes.filter((p) => p.session_id === sessionId).map((p) => ({ ...p, herdr: session.name })));
    if (!matches.length) throw new RequestError('No live Herdr pane is running that session, so nothing was sent.', 409, 'no_pane');
    if (matches.length > 1) throw new RequestError('Several Herdr panes show that session, so nothing was sent.', 409, 'several_panes');
    const pane = matches[0];
    if (pane.status === 'blocked') throw new RequestError('The agent is waiting at a permission prompt or question, so nothing was sent. Answer it in Herdr first.', 409, 'agent_blocked');
    // Herdr's own guide: `unknown` (or any other state) does not show the agent is in the
    // foreground, so the text could land in a shell. A working agent queues the message.
    if (!SENDABLE.has(pane.status)) throw new RequestError('Herdr cannot tell what the agent is doing (it may be suspended to a shell), so nothing was sent. Check the pane first.', 409, 'agent_unknown');
    try {
      await checkForeground(pane, sessionId);
      recordSendCheck(pane, sessionId, 'ok');
    } catch (error) {
      if (error && (error.code === 'other_session' || error.code === 'agent_not_foreground')) recordSendCheck(pane, sessionId, error.code);
      throw error;
    }
    if (sending) throw new RequestError('Another message is still being sent.', 409, 'busy');
    sending = true;
    try {
      if (pane.agent === 'codex' && typed.startsWith('$')) await pause(CODEX_SKILL_SETTLE_MS);
      for (let i = 0; i < CLEAR_CALLS; i += 1) {
        if (i) await pause(CLEAR_PAUSE_MS);
        const cleared = await runner(herdrBin, ['--session', pane.herdr, 'agent', 'send-keys', pane.pane_id, ...CLEAR_KEYS], { env: runEnv(), timeoutMs: 5000 });
        if (cleared.code !== 0) throw new RequestError('Herdr could not empty the pane\'s input box, so nothing was sent. Check the pane before sending again.', 502, 'herdr_failed');
      }
      const result = await runner(herdrBin, ['--session', pane.herdr, 'agent', 'prompt', pane.pane_id, text], { env: runEnv(), timeoutMs: 15000 });
      if (result.code !== 0) {
        if (/agent_blocked/.test(result.stdout + result.stderr)) throw new RequestError('The agent is waiting at a permission prompt or question, so nothing was sent. Answer it in Herdr first.', 409, 'agent_blocked');
        throw new RequestError(result.timedOut ? 'Herdr did not answer in time; check the pane before sending again.' : 'Herdr did not accept the message.', 502, 'herdr_failed');
      }
    } finally { sending = false; }
    // With photos, the text as it went (their paths are only known here); the page matches its log line by it.
    return { label: pane.label, herdr: pane.herdr, status: pane.status, ...(files.length ? { text } : {}) };
  }

  // ------------------------------------------------------------------- queue

  // The hosted copy's Send, from a page served here: the request is written into the copy's
  // q/ folder, for drain.js to send when the sync agent next runs. Nothing is sent to Herdr, and
  // a request is written once (never replaced), owner-only like every file this reader writes.
  function queueWrite(body) {
    for (const key of Object.keys(body)) if (!['copy', 'id', 'object', 'data'].includes(key)) throw new RequestError('Unknown field.');
    const folder = body.copy;
    if (folder !== 'hosted' && folder !== 'bucket') throw new RequestError('Unknown copy.');
    if (typeof body.id !== 'string' || !QUEUE_ID_RE.test(body.id)) throw new RequestError('Invalid request id.');
    let bytes;
    let name;
    if (folder === 'hosted') {
      const object = body.object;
      if (body.data !== undefined || !object || typeof object !== 'object' || Array.isArray(object)) throw new RequestError('Invalid request.');
      for (const key of Object.keys(object)) if (!['session_id', 'text', 'at'].includes(key)) throw new RequestError('Unknown field.');
      if (typeof object.session_id !== 'string' || !SESSION_ID_RE.test(object.session_id)) throw new RequestError('Invalid session id.');
      if (isCopilotSession(object.session_id)) throw new RequestError(COPILOT_SEND_REFUSAL, 409, 'copilot_send_unsupported');
      if (!Number.isFinite(object.at)) throw new RequestError('Invalid time.');
      bytes = Buffer.from(JSON.stringify({ id: body.id, session_id: object.session_id, text: checkText(object.text), at: object.at }), 'utf8');
      name = body.id + '.json';
    } else {
      // Sealed by the page: only its envelope can be checked here (the bytes open with the passphrase's key, which this server never has).
      if (body.object !== undefined || typeof body.data !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(body.data)) throw new RequestError('Invalid request.');
      bytes = Buffer.from(body.data, 'base64');
      if (bytes.length < 32 || bytes.length > MAX_QUEUE_BODY_BYTES || !bytes.subarray(0, 4).equals(SEALED_MAGIC)) throw new RequestError('That is not a sealed request.');
      name = body.id + '.json.enc';
    }
    const directory = path.join(outDir, folder, 'q');
    // A request taken back (unqueue) is never queued after that, whenever the post that carries it turns up.
    if (fs.existsSync(path.join(directory, cancelledName(body.id)))) throw new RequestError('That request was taken back, so it was not queued.', 409, 'cancelled');
    let waiting = 0;
    try { waiting = fs.readdirSync(directory).filter((entry) => !entry.startsWith('.')).length; } catch { waiting = 0; }
    if (waiting >= MAX_QUEUED) throw new RequestError('Too many messages are waiting for the laptop. Wait for them to be sent.', 429, 'queue_full');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    try { fs.writeFileSync(path.join(directory, name), bytes, { mode: 0o600, flag: 'wx' }); } catch (error) {
      if (error.code === 'EEXIST') throw new RequestError('That request is already queued.', 409, 'exists');
      throw new RequestError('The request could not be queued.', 500, 'queue_failed');
    }
    return { id: body.id, queued: waiting + 1 };
  }

  // Taking a queued message back. The request waits in q/<id>.json (plain) or q/<id>.json.enc (sealed), and the drain
  // takes it by renaming that file to <name>.claimed (drain.js), so a rename is the one atomic step both sides use: whoever
  // renames first has the message, and the other finds the file gone. This route renames it to a tombstone, .cancelled-<id>,
  // and empties that, so:
  //   cancelled  the message was waiting and is now taken back, or this server never had it (a send held on a phone whose
  //              post, or only its answer, was lost) and now refuses it if it still turns up. Either way no drain will send it.
  //   too_late   the drain has it (claimed, or its receipt is written): it is being sent, was sent, or was refused, and the
  //              receipt says which. Nothing is changed.
  // Nothing here can read a sealed request: it is never opened, only renamed.
  function unqueue(body) {
    for (const key of Object.keys(body)) if (key !== 'copy' && key !== 'id') throw new RequestError('Unknown field.');
    const folder = body.copy;
    if (folder !== 'hosted' && folder !== 'bucket') throw new RequestError('Unknown copy.');
    if (typeof body.id !== 'string' || !QUEUE_ID_RE.test(body.id)) throw new RequestError('Invalid request id.');
    const ext = folder === 'bucket' ? '.json.enc' : '.json';
    const directory = path.join(outDir, folder, 'q');
    const waiting = path.join(directory, body.id + ext);
    const tombstone = path.join(directory, cancelledName(body.id));
    const there = (file) => { try { fs.statSync(file); return true; } catch { return false; } };
    let renamed = false;
    try { fs.renameSync(waiting, tombstone); renamed = true; } catch (error) {
      if (error.code !== 'ENOENT') throw new RequestError('The message could not be taken back.', 500, 'unqueue_failed');
    }
    if (renamed) {
      // Taken back already; the tombstone only has to say so, so the request's text is not kept.
      try { fs.writeFileSync(tombstone, '', { mode: 0o600 }); } catch { /* the rename was the cancel */ }
      return { state: 'cancelled' };
    }
    if (there(tombstone)) return { state: 'cancelled' };
    if (there(waiting + '.claimed') || there(path.join(outDir, folder, 'r', body.id + ext))) return { state: 'too_late' };
    // Nothing here has ever had it. A tombstone makes sure a late copy of the same post is refused.
    let tombstones = 0;
    try { tombstones = fs.readdirSync(directory).filter((entry) => entry.startsWith('.cancelled-')).length; } catch { tombstones = 0; }
    if (tombstones >= MAX_TOMBSTONES) throw new RequestError('Too many messages were taken back recently. Try again later.', 429, 'queue_full');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(tombstone, '', { mode: 0o600 });
    return { state: 'cancelled' };
  }

  // -------------------------------------------------------------- HTML files

  // key -> { dir, entry, flat, only, expires } for each file shown: the folder it is in, its name, whether that folder is
  // itself an allowed root (so only its own files may load, nothing below), whether the file is all the key opens (an image),
  // and when the key lapses from disuse.
  const views = new Map();

  const within = (real, base) => real === base || real.startsWith(base + path.sep);
  const roots = () => [homeDir, ...tempRoots].map(realLocation);

  function pruneViews() {
    for (const [key, view] of views) if (view.expires <= now()) views.delete(key);
    while (views.size > MAX_VIEWS) views.delete(views.keys().next().value);
  }

  // What the Open button of an HTML file or an image asks: the file as the last build listed it, checked now. The listing
  // comes from the page's own build (never from the request), so only a file a listed conversation named, or that sits in a listed
  // leader's task folder, opens.
  const OPENABLE = {
    html: { listing: [HTML_FILES], type: HTML_PAGE_RE, limit: MAX_HTML_BYTES, not: ['That is not an HTML file.', 'not_html'] },
    image: { listing: [IMAGE_FILES], type: IMAGE_FILE_RE, limit: MAX_IMAGE_BYTES, not: ['That is not an image file.', 'not_image'] },
    md: { listing: [MD_FILES, LIVE_MD_FILES], type: MD_FILE_RE, limit: MAX_DOC_BYTES, not: ['That is not a markdown file.', 'not_markdown'] },
  };
  // The file the page asked for by its id, from the listing the last build wrote and checked now: still there, of the kind the listing is
  // for, inside the home or a temp folder, and within the limit.
  function listedFile(body, rules) {
    for (const key of Object.keys(body)) if (key !== 'id') throw new RequestError('Unknown field.');
    if (typeof body.id !== 'string' || !HTML_ID_RE.test(body.id)) throw new RequestError('Invalid file id.');
    // The first listing that names the id: the page's own, then (for markdown) the lite page's.
    let named = null;
    for (const name of rules.listing) {
      let listing = null;
      try { listing = parseJson(fs.readFileSync(path.join(outDir, name), 'utf8')); } catch { listing = null; }
      if (listing && typeof listing === 'object' && Object.hasOwn(listing, body.id)) { named = listing[body.id]; break; }
    }
    if (typeof named !== 'string' || !path.isAbsolute(named)) throw new RequestError('That file is not on the page. Sync to rebuild it.', 404, 'not_listed');
    let real;
    let stat;
    try { real = fs.realpathSync.native(named); stat = fs.statSync(real); } catch { throw new RequestError('That file is gone.', 404, 'gone'); }
    if (!stat.isFile()) throw new RequestError('That file is gone.', 404, 'gone');
    if (!rules.type.test(real)) throw new RequestError(rules.not[0], 404, rules.not[1]);
    if (!roots().some((root) => within(real, root))) throw new RequestError('That file is outside the home and temp folders.', 403, 'outside');
    if (stat.size > rules.limit) throw new RequestError('That file is over ' + (rules.limit >= 1024 * 1024 ? rules.limit / 1024 / 1024 + ' MB' : rules.limit / 1024 + ' KB') + '.', 413, 'too_big');
    return { real, stat };
  }

  function fileOpen(body, kind) {
    const { real, stat } = listedFile(body, OPENABLE[kind]);
    const key = crypto.randomBytes(16).toString('base64url');
    const dir = path.dirname(real);
    views.set(key, { dir, entry: path.basename(real), flat: roots().includes(dir), only: kind === 'image', expires: now() + VIEW_IDLE_MS });
    pruneViews();
    return { url: HTML_ROUTE + key + '/' + encodeURIComponent(path.basename(real)), name: path.basename(real), size: stat.size, mtime: stat.mtimeMs / 1000 };
  }

  // What the page asks to open a markdown file it lists without its text (a file in a leader's task folder that no conversation named): the
  // text as it is on disk now, under the same checks as an HTML file or a picture. Read only; the listing is the build's, never the request's.
  const mdHeld = new Map();  // folder -> when a read in it did not answer
  async function docOpen(body) {
    const { real, stat } = listedFile(body, OPENABLE.md);
    const folder = path.dirname(real);
    const stuck = new RequestError('That folder is not answering (macOS may be waiting for a permission, or a cloud folder is not syncing). Try again in a few minutes.', 504, 'unresponsive');
    if (mdHeld.has(folder) && now() - mdHeld.get(folder) < MD_HOLD_MS) throw stuck;
    mdHeld.delete(folder);
    let timer;
    const reading = fs.promises.readFile(real, 'utf8');
    const late = new Promise((resolve) => { timer = setTimeout(resolve, mdReadMs, null); if (timer.unref) timer.unref(); });
    let text;
    try { text = await Promise.race([reading, late]); } catch { throw new RequestError('That file is gone.', 404, 'gone'); } finally { clearTimeout(timer); }
    if (text === null) { mdHeld.set(folder, now()); reading.catch(() => {}); throw stuck; }
    return { text, name: path.basename(real), size: stat.size, mtime: stat.mtimeMs / 1000 };
  }

  // The file named by the address, as it is on disk now.
  function serveView(req, res) {
    const text = (status, message) => { res.writeHead(status, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }); res.end(message); };
    const verdict = guardFor(req).check(req, { requireToken: false, crossSite: true });
    if (!verdict.ok) { refused(req, res, verdict, () => text(verdict.status, verdict.message)); return; }
    if (req.method !== 'GET') { text(405, 'GET only'); return; }
    pruneViews();
    const [key, ...segments] = new URL(req.url, 'http://localhost').pathname.slice(HTML_ROUTE.length).split('/');
    const view = views.get(key);
    let parts;
    try { parts = segments.map(decodeURIComponent); } catch { parts = []; }
    // A name is one path segment: no empty or dot segment, no encoded slash or backslash, and nothing hidden (a dot
    // file or folder) other than the file itself.
    const valid = parts.length > 0 && parts.every((part) => part && part !== '.' && part !== '..' && !/[\\/\u0000]/.test(part));
    const entry = valid && parts.length === 1 && parts[0] === view?.entry;
    const type = valid && ASSET_TYPES[path.extname(parts[parts.length - 1]).toLowerCase()];
    if (!view || !valid || !type || (!entry && (view.only || parts.some((part) => part.startsWith('.')) || (view.flat && parts.length > 1)))) { text(404, 'Not found'); return; }
    let real;
    let stat;
    try { real = fs.realpathSync.native(path.join(view.dir, ...parts)); stat = fs.statSync(real); } catch { text(404, 'Not found'); return; }
    if (!stat.isFile() || !within(real, view.dir) || !roots().some((root) => within(real, root))) { text(404, 'Not found'); return; }
    if (stat.size > (view.only ? MAX_IMAGE_BYTES : HTML_PAGE_RE.test(real) ? MAX_HTML_BYTES : MAX_ASSET_BYTES)) { text(413, 'Too big'); return; }
    view.expires = now() + VIEW_IDLE_MS;
    const stream = fs.createReadStream(real);
    stream.on('error', () => { if (!res.headersSent) text(404, 'Not found'); else res.end(); });
    stream.on('open', () => {
      res.writeHead(200, {
        'Content-Type': type, 'Content-Length': stat.size, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': type.startsWith('text/html') ? VIEW_CSP : ASSET_CSP, 'X-Frame-Options': 'SAMEORIGIN',
      });
      stream.pipe(res);
    });
  }

  // ------------------------------------------------------------------- routes

  function servePage(req, res, name) {
    const text = (status, message) => { res.writeHead(status, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }); res.end(message); };
    const verdict = guardFor(req).check(req, { requireToken: false });
    if (!verdict.ok) { refused(req, res, verdict, () => text(verdict.status, verdict.message)); return; }
    if (req.method !== 'GET') { text(405, 'GET only'); return; }
    // Only a browser tab opening the page gets it (and so the token), never a script's
    // fetch, a frame or an embed. Like the guard, a request without Fetch-Metadata
    // (curl, an old browser) is let through.
    const mode = req.headers['sec-fetch-mode'];
    const dest = req.headers['sec-fetch-dest'];
    if ((mode !== undefined && mode !== 'navigate') || (dest !== undefined && dest !== 'document')) {
      // One exception, for the offline copy: its page keeps the shell pages in a cache for the service worker, and asks for them
      // with the token it holds. Whoever holds the token already has what the page would tell it, so nothing more is given away.
      const own = SHELL_PAGES.has(name) && guardFor(req).check(req, { quiet: true }).ok;
      if (!own) { text(403, 'Open this page in its own browser tab.'); return; }
    }
    if (!PAGES.has(name)) { text(404, 'Not found'); return; }
    fs.readFile(path.join(outDir, name), 'utf8', (error, html) => {
      if (error) { text(404, 'Not built yet: run python3 setup/transcript-reader/' + (name.startsWith('hosted/') ? 'sync.py --build-only' : name.startsWith('bucket/') ? 'sync.py --seal' : 'reader.py')); return; }
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "frame-ancestors 'none'", 'X-Frame-Options': 'DENY', 'Cross-Origin-Opener-Policy': 'same-origin',
        [COPY_HEADER]: copy,
      });
      res.end(html.replace(TOKEN_META, () => TOKEN_META.replace(TOKEN_SLOT, guard.token)));
      // The build this page holds is what its first update is measured from.
      if (name === 'prototype.html') setImmediate(() => deltas.note(html));
    });
  }

  function serveBoardPage(req, res) {
    const text = (status, message) => { res.writeHead(status, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }); res.end(message); };
    const verdict = guardFor(req).check(req, { requireToken: false });
    if (!verdict.ok) { refused(req, res, verdict, () => text(verdict.status, verdict.message)); return; }
    if (req.method !== 'GET') { text(405, 'GET only'); return; }
    // Only a browser tab opening the page gets the token, as for every page of the reader.
    const mode = req.headers['sec-fetch-mode'];
    const dest = req.headers['sec-fetch-dest'];
    if ((mode !== undefined && mode !== 'navigate') || (dest !== undefined && dest !== 'document')) { text(403, 'Open this page in its own browser tab.'); return; }
    let html;
    try { html = board.page(); } catch { text(404, 'The Tasks page is not in this copy.'); return; }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "frame-ancestors 'none'", 'X-Frame-Options': 'DENY', 'Cross-Origin-Opener-Policy': 'same-origin', [COPY_HEADER]: copy,
    });
    res.end(html.replace(TOKEN_META, () => TOKEN_META.replace(TOKEN_SLOT, guard.token)));
  }

  // The windowed lite page (storeapi/page.js), served like any page: only to a browser tab opening it, with the per-start token written in.
  const storeApiPage = () => require('./storeapi/page').build(root);
  function serveWindowedPage(req, res) {
    const text = (status, message) => { res.writeHead(status, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }); res.end(message); };
    const verdict = guardFor(req).check(req, { requireToken: false });
    if (!verdict.ok) { text(verdict.status, verdict.message); return; }
    if (req.method !== 'GET') { text(405, 'GET only'); return; }
    const mode = req.headers['sec-fetch-mode'];
    const dest = req.headers['sec-fetch-dest'];
    if ((mode !== undefined && mode !== 'navigate') || (dest !== undefined && dest !== 'document')) { text(403, 'Open this page in its own browser tab.'); return; }
    let html;
    try { html = storeApi.pageHtml(); } catch { html = null; }
    if (!html) { text(404, 'Not found'); return; }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "frame-ancestors 'none'", 'X-Frame-Options': 'DENY', 'Cross-Origin-Opener-Policy': 'same-origin', [COPY_HEADER]: copy,
    });
    res.end(html.replace(TOKEN_META, () => TOKEN_META.replace(TOKEN_SLOT, guard.token)));
  }

  // The service worker, manifest and icons beside a copy's shell pages: not secret, but behind the same Host, Origin and (on the tailnet) sign-in checks.
  function serveStatic(req, res, folder, name) {
    const verdict = guardFor(req).check(req, { requireToken: false });
    if (!verdict.ok) { refused(req, res, verdict, () => fail(res, verdict.status, 'refused', verdict.message)); return; }
    if (req.method !== 'GET') { fail(res, 405, 'not_allowed', 'GET only.'); return; }
    fs.readFile(path.join(outDir, folder, name), (error, body) => {
      if (error) { fail(res, 404, 'not_built', 'Not built yet.'); return; }
      res.writeHead(200, { 'Content-Type': STATIC_TYPES[name], 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
      res.end(body);
    });
  }

  // An object a hosted shell loads (plain under out/hosted/, sealed under out/bucket/). Like the API
  // it needs the token, which only the shell opened in a tab holds, so another page on this origin
  // cannot read the transcripts here either.
  function serveObject(req, res, folder, name) {
    const verdict = guardFor(req).check(req);
    if (!verdict.ok) { refused(req, res, verdict, () => fail(res, verdict.status, 'refused', verdict.message)); return; }
    if (req.method !== 'GET') { fail(res, 405, 'not_allowed', 'GET only.'); return; }
    const kind = OBJECTS[folder];
    if (!kind.re.test(name)) { fail(res, 404, 'not_found', 'Not found.'); return; }
    fs.readFile(path.join(outDir, folder, name), (error, body) => {
      if (error) { fail(res, 404, 'not_built', 'Not built yet.'); return; }
      res.writeHead(200, { 'Content-Type': name.endsWith('.json') ? 'application/json; charset=utf-8' : kind.type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(body);
    });
  }

  // The hook's call. It is the one route that is not a page's: Claude Code runs a command that posts the ask here and holds the call until an
  // answer (permissions.js says what is taken and what is not). A web page cannot make this request: it needs a key only the hook's file holds, a
  // Host naming loopback, and no Origin or Fetch-Metadata header (every browser fetch carries at least one of them). The key opens nothing else.
  async function permissionAsk(req, res, listener) {
    const refuse = (status, code, message) => fail(res, status, code, message);
    if (!permissions.enabled) { refuse(404, 'not_found', 'Not found.'); return; }
    if (listener !== 'loopback' || guards.has(req)) { refuse(403, 'refused', 'Not served here.'); return; }
    if (req.method !== 'POST') { refuse(405, 'not_allowed', 'POST only.'); return; }
    const host = String(req.headers.host || '').toLowerCase();
    if (!/^(?:localhost|127\.0\.0\.1|\[::1\]):\d{1,5}$/.test(host)) { refuse(403, 'refused', 'Host not allowed for this endpoint.'); return; }
    if (req.headers.origin !== undefined || Object.keys(req.headers).some((name) => name.startsWith('sec-fetch-'))) { refuse(403, 'refused', 'Not for a page.'); return; }
    if (String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json') { refuse(415, 'refused', 'JSON body required.'); return; }
    if (!permissions.hookKeyMatches(req.headers['x-transcript-reader-hook'])) { refuse(403, 'refused', 'Missing or invalid key.'); return; }
    let payload;
    try { payload = await readJsonBody(req, permissionsLib.MAX_SHOWN_BYTES * 2 + 8192); } catch (error) {
      if (error instanceof RequestError) { refuse(error.status, error.code, error.message); return; }
      throw error;
    }
    const answer = await permissions.ask(payload, { onClose: (fn) => res.on('close', () => { if (!res.writableEnded) fn(); }) });
    if (res.destroyed || res.writableEnded) return;
    send(res, 200, { status: 'ok', ...answer });
  }

  async function dispatch(req, res, pathname, query) {
    const verdict = guardFor(req).check(req);
    if (!verdict.ok) { refused(req, res, verdict, () => fail(res, verdict.status, 'refused', verdict.message)); return; }
    if (storeApi && storeApi.claims(pathname, API)) {
      const listener = listeners.get(req) || 'loopback';
      await ensureWatch();
      storeApi.handle(req, res, pathname, query, { api: API, remote: listener !== 'loopback' });
      return;
    }
    if (pathname === API + 'page' && req.method === 'GET') {
      const name = query.get('name');
      if (!PAGES.has(name)) { fail(res, 404, 'not_found', 'Not found.'); return; }
      let html;
      try { html = fs.readFileSync(path.join(outDir, name), 'utf8'); } catch { fail(res, 404, 'not_built', 'Not built yet.'); return; }
      send(res, 200, { status: 'ok', html });
      if (name === 'prototype.html') setImmediate(() => deltas.note(html));
      return;
    }
    // What changed since the build the page holds (`have`, its generated time), in place of the whole page: only the reader
    // page has one. { delta: false } sends the page to the full text above.
    if (pathname === API + 'delta' && req.method === 'GET') {
      const have = Number(query.get('have'));
      if (query.get('name') !== 'prototype.html') { fail(res, 404, 'not_found', 'Not found.'); return; }
      if (!Number.isFinite(have)) { fail(res, 400, 'bad_request', 'Invalid build.'); return; }
      let html;
      try { html = fs.readFileSync(path.join(outDir, 'prototype.html'), 'utf8'); } catch { fail(res, 404, 'not_built', 'Not built yet.'); return; }
      send(res, 200, { status: 'ok', ...deltas.since(html, have) });
      return;
    }
    if (pathname === API + 'events' && req.method === 'GET') {
      events(res, query);
      return;
    }
    if (pathname === API + 'state' && req.method === 'GET') {
      // Where the Tasks page is served from this address, the reader page shows its Tasks link (and which board each conversation belongs to, from the boards already read).
      const boardHere = board.enabled && (!guards.has(req) || (boardTailnet && guards.get(req) === httpsLane.guard));
      send(res, 200, { status: 'ok', ...(await state(query.get('follow') === '1', query.get('boot') === '1')), ...(boardHere ? { board: { page: BOARD_PAGE, boards: board.readerBoards(), write: { marks: !guards.has(req) && Boolean(board.write.marks) } } } : {}) });
      return;
    }
    if (pathname === API + 'permissions' && req.method === 'GET') {
      if (!permissions.enabled) { fail(res, 404, 'not_found', 'Not found.'); return; }
      seen();
      const session = query.get('session');
      if (session !== null && !SESSION_ID_RE.test(session)) { fail(res, 400, 'bad_request', 'Invalid session id.'); return; }
      const have = Number(query.get('rev'));
      const wait = Math.min(Math.max(Number(query.get('wait')) || 0, 0), MAX_WAIT_MS);
      permissions.list(session, { touch: true });
      if (Number.isFinite(have) && wait > 0) {
        const aborted = new Promise((resolve) => res.on('close', resolve));
        await Promise.race([permissions.wait(have, wait), aborted]);
        if (res.destroyed) return;
      }
      send(res, 200, { status: 'ok', ...permissions.list(session, { touch: true }), write: !guards.has(req) });
      return;
    }
    if (pathname === API + 'permission-answer' && req.method === 'POST') {
      if (!permissions.enabled) { fail(res, 404, 'not_found', 'Not found.'); return; }
      if (guards.has(req)) { fail(res, 403, 'not_on_the_phone', 'Permission asks are answered on the laptop only.'); return; }
      const body = await readJsonBody(req);
      for (const key of Object.keys(body)) if (!['id', 'shown', 'decision'].includes(key)) throw new RequestError('Unknown field.');
      try { send(res, 200, { status: 'ok', ask: await permissions.answer(body) }); } catch (error) {
        if (error instanceof permissionsLib.PermissionError) { fail(res, error.status, error.code, error.message); return; }
        throw error;
      }
      return;
    }
    // The open asks of the live panes, for a client that lists them: { generated_at, as_of, asks: [{ pane_id, herdr, session, message, lines, at, tags, older }] }.
    if (pathname === API + 'open-asks' && req.method === 'GET') {
      send(res, 200, { status: 'ok', ...(await openAsks()) });
      return;
    }
    if (pathname === API + 'sync' && req.method === 'POST') {
      send(res, 200, { status: 'ok', ...(await sync(await readJsonBody(req))) });
      return;
    }
    // The hosted and sealed copies' Sync: have the laptop build the copy now (or join the build under way), then ask again until it is over.
    if (pathname === API + 'copy-sync' && req.method === 'POST') {
      send(res, 200, { status: 'ok', ...copySync.start(copyNamed((await readJsonBody(req)).copy)) });
      return;
    }
    if (pathname === API + 'copy-sync' && req.method === 'GET') {
      send(res, 200, { status: 'ok', ...copySync.status(copyNamed(query.get('copy'))) });
      return;
    }
    // The tool output of one conversation, for a step the local page opens (the page build writes it beside the page, apart from the turns).
    if (pathname === API + 'steps' && req.method === 'GET') {
      const conv = query.get('conv') || '';
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(conv)) { fail(res, 400, 'bad_request', 'Invalid conversation.'); return; }
      let kept = {};
      try { kept = JSON.parse(fs.readFileSync(path.join(outDir, 'steps', conv + '.json'), 'utf8')).outputs || {}; } catch { kept = {}; }
      send(res, 200, { status: 'ok', outputs: kept });
      return;
    }
    // The Tasks board (a flag, off by default; loopback only, and its reads also on the TLS address when boardTailnet is on: the phone's offline copy is a
    // separate decision, with its own sealing). Its writes have a flag each (board.js): a mark on a task's record, an answer to a call, the message box.
    const boardLoopback = !guards.has(req);
    if (pathname.startsWith(API + 'board') && board.enabled && (boardLoopback || (boardTailnet && guards.get(req) === httpsLane.guard))) {
      const boardFail = (error) => { if (error && error.status) { fail(res, error.status, error.code, error.message); return true; } return false; };
      if (pathname === API + 'board-sessions' && req.method === 'GET') {
        send(res, 200, { status: 'ok', ...(await board.sessions()), write: boardLoopback ? board.write : { marks: false, answer: false, send: false, review: false } });
        return;
      }
      if (pathname === API + 'board' && req.method === 'GET') {
        try { send(res, 200, { status: 'ok', ...(await board.board(query.get('session'), { fresh: query.get('fresh') === '1' })), write: boardLoopback ? board.write : { marks: false, answer: false, send: false, review: false } }); } catch (error) { if (!boardFail(error)) throw error; }
        return;
      }
      if (pathname === API + 'board-reply' && req.method === 'GET') {
        try { send(res, 200, { status: 'ok', ...(await board.reply(query.get('session'), query.get('sid'), query.get('uid'))) }); } catch (error) { if (!boardFail(error)) throw error; }
        return;
      }
      // A message to a supervisor's pane, from the Tasks page's composer: the board's own flag and its own session list first (board.sendCheck), then the
      // reader's Send itself, unchanged (the same pane, foreground and Herdr checks as the conversation view's). The body is checked there, not here.
      if (!boardLoopback && req.method !== 'GET') { fail(res, 403, 'not_on_the_phone', 'The board\'s writes are not offered on the phone.'); return; }
      if (pathname === API + 'board-send' && req.method === 'POST') {
        const body = await readJsonBody(req);
        try {
          board.sendCheck(body.session, body.session_id);
          send(res, 200, { status: 'ok', ...(await sendPrompt({ session_id: body.session_id, text: body.text, ...(body.images ? { images: body.images } : {}) })) });
        } catch (error) { if (!boardFail(error)) throw error; }
        return;
      }
      if (req.method === 'POST' && (pathname === API + 'board-mark' || pathname === API + 'board-answer' || pathname === API + 'board-review' || pathname === API + 'board-round' || pathname === API + 'board-worker')) {
        const body = await readJsonBody(req);
        try {
          if (pathname === API + 'board-worker') send(res, 200, { status: 'ok', ...(await board.workerSwitch(body)) });
          else if (pathname === API + 'board-round') send(res, 200, { status: 'ok', ...(await board.round(body.session, { op: body.op, task: body.task })) });
          else if (pathname === API + 'board-review') send(res, 200, { status: 'ok', ...(await board.review(body.session, { task: body.task, action: body.action, note: body.note, until: body.until, title: body.title, due: body.due })) });
          else if (pathname === API + 'board-mark') send(res, 200, { status: 'ok', ...(await board.mark(body.session, { task: body.task, turn: body.turn, mark: body.mark, source: body.source === 'reader' ? 'reader' : 'card' })) });
          else send(res, 200, { status: 'ok', ...(await board.answer(body.session, { task: body.task, call: body.call, src: body.src, option: body.option, text: body.text, later: body.later, calls: body.calls, release: body.release })) });
        } catch (error) { if (!boardFail(error)) throw error; }
        return;
      }
    }
    if (pathname === API + 'pins' && req.method === 'GET') {
      send(res, 200, { status: 'ok', ...pins.read() });
      return;
    }
    if (pathname === API + 'pins' && req.method === 'POST') {
      send(res, 200, { status: 'ok', ...pins.change(await readJsonBody(req)) });
      return;
    }
    if (pathname === API + 'stars' && req.method === 'GET') {
      send(res, 200, { status: 'ok', ...stars.read() });
      return;
    }
    if (pathname === API + 'stars' && req.method === 'POST') {
      send(res, 200, { status: 'ok', ...stars.change(await readJsonBody(req)) });
      return;
    }
    // The replies marked "should be an answer sheet" or "this sheet is wrong" (reader.py sheet-flags lists them), and one change to them.
    if (pathname === API + 'sheet-flags' && req.method === 'GET') {
      send(res, 200, { status: 'ok', ...sheetFlags.read() });
      return;
    }
    if (pathname === API + 'sheet-flags' && req.method === 'POST') {
      send(res, 200, { status: 'ok', ...sheetFlags.change(await readJsonBody(req)) });
      return;
    }
    // The messages and replies hidden from the reader's view, and one change to them (a view setting only: nothing of a session log changes).
    if (pathname === API + 'hidden' && req.method === 'GET') {
      send(res, 200, { status: 'ok', ...hidden.read() });
      return;
    }
    if (pathname === API + 'hidden' && req.method === 'POST') {
      send(res, 200, { status: 'ok', ...hidden.change(await readJsonBody(req)) });
      return;
    }
    // Build the pages again now, with the sheet finder as it is on disk (the worker starts again from changed code), so a reply marked
    // wrong or missing shows what the finder makes of it today. Answers when the pages are built.
    if (pathname === API + 'rerender' && req.method === 'POST') {
      send(res, 200, { status: 'ok', ...(await rerender(await readJsonBody(req))) });
      return;
    }
    if (pathname === API + 'send' && req.method === 'POST') {
      send(res, 200, { status: 'ok', ...(await sendPrompt(await readJsonBody(req))) });
      return;
    }
    if (pathname === API + 'upload' && req.method === 'POST') {
      const tooBig = { message: 'That photo is too big: a photo can be at most ' + megabytes(MAX_PHOTO_BYTES) + '.', code: 'too_big' };
      send(res, 200, { status: 'ok', ...(await uploadPhoto(await readJsonBody(req, MAX_UPLOAD_BODY_BYTES, tooBig))) });
      return;
    }
    for (const kind of ['html', 'image']) {
      if (pathname === API + kind + '-open' && req.method === 'POST') {
        send(res, 200, { status: 'ok', ...fileOpen(await readJsonBody(req), kind) });
        return;
      }
    }
    if (pathname === API + 'md-open' && req.method === 'POST') {
      send(res, 200, { status: 'ok', ...(await docOpen(await readJsonBody(req))) });
      return;
    }
    if (pathname === API + 'queue' && req.method === 'POST') {
      send(res, 200, { status: 'ok', ...queueWrite(await readJsonBody(req, MAX_QUEUE_BODY_BYTES)) });
      return;
    }
    if (pathname === API + 'unqueue' && req.method === 'POST') {
      send(res, 200, { status: 'ok', ...unqueue(await readJsonBody(req)) });
      return;
    }
    if (pathname === API + 'add-tab' && req.method === 'POST') {
      send(res, 200, { status: 'ok', ...(await addTab(await readJsonBody(req))) });
      return;
    }
    for (const command of ['reopen', 'close']) {
      if (pathname === API + command && req.method === 'POST') {
        send(res, 200, { status: 'ok', ...(await changeList(command, await readJsonBody(req))) });
        return;
      }
    }
    fail(res, 404, 'not_found', 'Not found.');
  }

  const insideOut = (req, url) => requestsOut(root, outDir, req, url);

  // Returns true when the request belongs to this module (and is handled here). listener is
  // 'tailnet' (plain HTTP) or 'tailnet-https' for a request that came in on the Tailscale address, which must be signed in
  // first (tailnet.js); anything else is a loopback request, handled as it always was.
  function handle(req, res, listener = 'loopback') {
    let url;
    // A request URL nothing can parse may still name out/, so it is refused here rather
    // than passed on to the shared static handler.
    try { url = new URL(req.url, 'http://localhost'); } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
      res.end('Bad request');
      return true;
    }
    // The Tasks page (board/page/): a built-in page of the reader's own, opened in a browser tab like the others; off with the board flag, on the TLS address
    // only with boardTailnet, and never on the plain tailnet one.
    const boardPage = board.enabled && (url.pathname === BOARD_PAGE || url.pathname === BOARD_PAGE + 'index.html');
    if (boardPage && listener === 'loopback') { serveBoardPage(req, res); return true; }
    // The Claude hook's route (hooks/permission-hook.py): a command, not a page, so it carries its own key instead of the page token. Loopback only.
    if (url.pathname === API + 'permission-ask') { permissionAsk(req, res, listener); return true; }
    const page = insideOut(req, url);
    const viewing = !page.inside && url.pathname.startsWith(HTML_ROUTE);
    listeners.set(req, listener);
    const windowed = Boolean(storeApi) && url.pathname === WINDOWED_PAGE;
    if (listener === 'tailnet' || listener === 'tailnet-https') {
      const lanes = listener === 'tailnet' ? lane : httpsLane;
      if (!lanes) { res.writeHead(403, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }); res.end('Not served here'); return true; }
      if (lanes.intercept(req, res, url, (page.inside && page.name.endsWith('.html')) || asksForBoard || windowed, viewing)) return true;
      guards.set(req, lanes.guard);
      if (asksForBoard) { serveBoardPage(req, res); return true; }
    }
    if (viewing) { serveView(req, res); return true; }
    if (windowed) { serveWindowedPage(req, res); return true; }
    if (page.inside) {
      const folder = Object.keys(OBJECTS).find((name) => page.name.startsWith(name + path.sep));
      if (folder && Object.hasOwn(STATIC_TYPES, page.name.slice(folder.length + 1))) serveStatic(req, res, folder, page.name.slice(folder.length + 1));
      else if (folder && !PAGES.has(page.name)) serveObject(req, res, folder, page.name.slice(folder.length + 1));
      else servePage(req, res, page.name);
      return true;
    }
    if (!url.pathname.startsWith(API)) return false;
    dispatch(req, res, url.pathname, url.searchParams).catch((error) => {
      if (res.headersSent) { res.end(); return; }
      if (error instanceof RequestError || error instanceof pinstore.PinError) fail(res, error.status, error.code, error.message);
      else fail(res, 500, 'internal', 'Unexpected error.');
    });
    return true;
  }

  // The compatibility writers need Herdr watched from the start, not from the first page that asks.
  if (storeApi && storeApiOption.compat) ensureWatch();

  return { handle, guard, scan, sendPrompt, close, tailnet: lane, tailnetHttps: httpsLane, permissions, publishHook: (port) => permissions.publishHook(port), storeApi };
}

module.exports = { create, readSnapshot, canonicalSessionId, otherClaudeHomes, checkText, copyId, namesReaderOut, sniffImage, RequestError, API, TOKEN_HEADER, TOKEN_META, COPY_HEADER, PHOTO_LIMITS: { MAX_PHOTOS, MAX_PHOTO_BYTES, MAX_PHOTOS_BYTES } };
