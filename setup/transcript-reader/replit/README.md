# The hosted transcript reader on Replit (part 3)

A small Node app for ShopBack's Replit workspace. It lets the owner read the transcript reader from a phone while the laptop is off. The laptop keeps sealing the copy as it does today (`sync.py`) and `push.py` sends the sealed files here. The app stores them in Replit Object Storage and serves them to one signed-in person, with the same shell page, which you deploy with the app (below).

Nothing here was deployed or run against Replit or any sign-in provider from the build machine. Every check ran against local stand-ins (`app.test.js`, `units.test.js`, `../test_push.py`). "What was not verified" at the end lists what only the first deploy can confirm.

## How it works

```
laptop: sync.py (build, redact, seal)  ->  push.py  --upload key-->  the app (Replit)  <--sign-in--  phone
                                                                        |
                                                                Replit Object Storage (ciphertext only)
```

- **The app never decrypts.** It holds no passphrase and no decryption code (a test checks the sources). The shell page in the browser asks for the passphrase and opens the objects there.
- **Owner-only comes from the app, not from Replit.** Replit's own visibility is "workspace" or "public". The app signs people in through OpenID Connect (JumpCloud, the Marking-Down pattern; Google also works) and lets in only the emails in `ALLOWED_EMAILS`. The allow-list is read again on every request, so removing an address ends that session at once.
- **Three kinds of caller.** Nobody signed in gets the login page and nothing else. The signed-in owner reads everything and may queue a message. The laptop's upload key writes the copy.

| Caller | May do | Refused |
|---|---|---|
| Not signed in | `GET /`, `/login` (the sign-in page), `/auth/start`, `/auth/callback` | everything else: 401 |
| Signed-in, allow-listed owner | `GET` the shell pages and every sealed object, receipt and queued message; `POST /api/transcript-reader/queue` (the Send queue, the same route and body as the reader's own server: `{copy: "bucket", id, data}` with the sealed request in base64; from the page only, never overwrites, at most 50 waiting) | any other write or delete |
| Laptop upload key (`Authorization: Bearer hrk_...`) | `GET /api/objects[?prefix=s/]` (names and sizes), `PUT` `k/params.json`, sealed objects and receipts, `DELETE` objects, queued messages and receipts, `GET` queued messages | reading sealed objects back, writing `q/`, deleting the key parameters, plain content, and the shell pages: they are code, so the app serves them only from the files you deploy with it |

The upload accepts only bytes that look like what `sync.py` produces: sealed objects (`HRC1` magic, at least 32 bytes), `k/params.json` with exactly its six fields, and nothing else. The shell pages (`index.html`, `sheet.html`) are never accepted as an upload: they are read from the app's own `shell/` folder, so a leaked upload key cannot swap the page that asks for your passphrase. The key derivation keeps its floor (`k/params.json` needs 600,000 to 10,000,000 rounds). Names are matched against a fixed list (`names.js`: `index.html`, `sheet.html`, `k/params.json`, `index.json.enc`, `s|d|f|a/<id>.json.enc`, `q/` and `r/<uuid>.json.enc`), so a path with `..`, an encoded dot, a backslash or any other name never reaches storage. Size limits: 32 MiB per object, 4 KiB parameters, 64 KiB per queued message (the reader's own limit).

Upload keys are 256-bit random values shown once; only their SHA-256 hash is stored (`_admin/keys.json` in the same storage, never served). Revoking one takes effect on the next request.

Decisions you may want to change:

- A session lasts 7 days (`SESSION_HOURS`). You accepted the stolen-session risk for the Send queue, so queue writes use the same session check, with no extra write token. The route also needs the page's own JSON type (or the `X-Requested-With: transcript-reader` header) and, when the browser sends them, a matching `Origin` and a same-origin `Sec-Fetch-Site`, so another site cannot post for you.
- Wrong upload keys from one address are answered 429 after 10 a minute; a right key is never turned away.
- Queue objects are `q/<uuid>.json.enc` and receipts `r/<uuid>.json.enc`, the names `drain.js` reads and writes. The page's Send must post to `/api/transcript-reader/queue` as above and read its receipt from `r/<uuid>.json.enc` (a plain `GET`).
- When the session ends (7 days, or the allow-list changes), the open page's next load fails with 401 until you reload it, which shows the sign-in page.

## What the workspace admins can and cannot see

Can see:

- The project's files and code, its deployment logs, and the app's request metadata (times, paths, sizes, addresses). The app logs no email addresses and no key.
- The secrets. Whoever can open the project's Secrets can read `SESSION_SECRET` and forge an owner session, and can read the OIDC client secret. A forged session reads only ciphertext (the passphrase is the second lock).
- Object Storage: the sealed objects, their count, sizes and update times. That is metadata about your activity: how many conversations, how big, how often you work.
- Who can edit the deployed app. Someone with edit access could redeploy a changed shell page that records the passphrase when you type it. Encryption protects what is stored and what a reader of storage sees. It does not protect against a host that changes the page you open. Keep the project private to you, and use a passphrase you use nowhere else. A leaked upload key is not enough for this: the key writes sealed objects only, never the page.

Cannot see:

- Any transcript text, document, message or file name without the passphrase. The passphrase never leaves your browser and the laptop. Objects use AES-256-GCM under a key from PBKDF2 (600,000 rounds), so a long passphrase matters: someone holding the ciphertext can try guesses offline.

## Files

| File | Job |
|---|---|
| `main.js`, `app.js` | start-up and the request handler |
| `oidc.js`, `session.js`, `config.js` | sign-in (code flow with PKCE, RS256 ID-token check), signed cookies, settings from the environment |
| `names.js`, `store.js`, `keys.js` | the names and bodies accepted, the object stores (Replit, folder, memory), upload keys |
| `keys-cli.js` | make, list and revoke upload keys from the Replit shell |
| `shell/` (you add it) | the two shell pages, `index.html` and `sheet.html`, copied out of the sealed folder with `push.py --copy-shell` |
| `../push.py` | the laptop's sync target: fetches queued messages into the sealed folder, runs `sync.py` (which drains them), then uploads what changed and the receipts |

## Deploy steps (you run these)

You need a ShopBack Replit workspace, and an OpenID Connect client for the app. I could not check how Marking-Down's client was registered; ask whoever owns it (the Marking-Down page names JumpCloud sign-in), or ask IT for a JumpCloud OIDC application with:

- redirect URI `https://YOUR_APP_NAME_HERE.replit.app/auth/callback`
- scopes `openid email profile`, code flow, a client secret
- the client ID and secret, which go only into Replit Secrets below

1. **Create a private project.** In Replit, create a new Node.js app named for the reader and keep it private to you. Upload these files from this `replit/` folder into it (the files, not the folder): `main.js`, `app.js`, `oidc.js`, `session.js`, `config.js`, `names.js`, `store.js`, `keys.js`, `keys-cli.js` and `package.json`. The tests and `harness.js` need the rest of the repo and stay here.
2. **Add Object Storage.** In the Tools panel add Object Storage and create a bucket. The app uses the project's default bucket through `@replit/object-storage`, which `package.json` lists.
3. **Set the secrets** (Tools, Secrets). Use these names:

   | Secret | Value |
   |---|---|
   | `APP_URL` | `https://YOUR_APP_NAME_HERE.replit.app` (no trailing slash; the deployed address) |
   | `OIDC_CLIENT_ID` | `YOUR_OIDC_CLIENT_ID_HERE` |
   | `OIDC_CLIENT_SECRET` | `YOUR_OIDC_CLIENT_SECRET_HERE` |
   | `SESSION_SECRET` | `YOUR_RANDOM_32_PLUS_CHARACTERS_HERE` (make one in the Replit shell: `openssl rand -base64 48`) |
   | `ALLOWED_EMAILS` | `YOUR_SHOPBACK_EMAIL_HERE` (comma-separated for more than one) |
   | `OIDC_ISSUER` | optional; defaults to `https://oauth.id.jumpcloud.com/`. Use `https://accounts.google.com` for Google |
   | `OIDC_EMAIL_VERIFIED_OPTIONAL` | optional; set to `1` only if sign-in is refused with "provider did not say the email is verified" in the logs and the provider is the company directory |
   | `TRUST_PROXY` | optional; `1` makes the wrong-key limit use the proxy's forwarded address |

   The app refuses to start without the first five, and says which one is missing, never its value.
4. **Deploy with public visibility.** Pick a deployment (Autoscale is enough; the run command is `node main.js`) and set its visibility to **Public**. This is the same change the Marking-Down team made (`shared-context/projects/marking-down/decisions/remove-replit-shield.md`): in "Workspace only" Replit puts a challenge page in front of everything, which blocks the laptop's upload from a script. Public does not expose data, because every route except the sign-in page answers 401 until sign-in, and the stored bytes are ciphertext. Answering your question "can Replit be a personal site only": Replit itself cannot, so the sign-in and the allow-list do it.
5. **Make the laptop's upload key.** In the Replit shell: `node keys-cli.js create laptop`. Copy the key it prints once. Then, on the Mac, keep it in the keychain (the same way as the Marking-Down key; the input is hidden and never lands in shell history):

   ```bash
   echo "Enter key (input hidden):" && read -rs TOKEN && echo ""
   security add-generic-password -a "$USER" -s "pmos-hosted-reader-upload-key" -w "$TOKEN" -U && unset TOKEN
   ```

6. **First upload.** From the repo root on the laptop:

   ```bash
   python3 setup/transcript-reader/push.py https://YOUR_APP_NAME_HERE.replit.app
   ```

   It asks for the passphrase (twice, the first time) or reads `HOSTED_READER_PASSPHRASE`, seals the copy, then uploads. Each run also carries the Send queue: it copies messages queued on the app into the sealed folder's `q/` before the sync (whose drain sends them and writes receipts to `r/`), then uploads the receipts and removes the answered messages from the app. The first run sends every conversation of the last 90 days (about 15 MB on the current reading list), so allow some minutes. Later runs send only what changed.
7. **Deploy the shell pages.** The first push ends by saying the shell pages are not deployed yet. Copy them out and put them in the app:

   ```bash
   python3 setup/transcript-reader/push.py --copy-shell setup/transcript-reader/out/shell-for-replit
   ```

   Upload `index.html` and `sheet.html` from that folder into a `shell/` folder in the Replit project, then redeploy. They hold no transcript. The upload key cannot do this for you, on purpose. Do it again whenever a push says the shell pages changed (when the reader's page code changes, not on every sync).
8. **Open it on the phone.** Visit the app address, sign in with your ShopBack account, enter the passphrase once ("Remember on this device" keeps the derived key in that browser).
9. **Keep it fresh** (optional): `python3 setup/transcript-reader/push.py https://YOUR_APP_NAME_HERE.replit.app --launch-agent` prints a LaunchAgent that runs it every minute while the Mac is awake. It is printed only; installing it is yours to do.

Things to know:

- `push.py` seals into its own folder (`out/bucket-hosted/`), apart from the local review bucket (`out/bucket/`). `sync.py` remembers what it sealed for one folder at a time, so running `sync.py --dry-run` into another folder between two pushes makes the next push seal and send everything again.
- Changing the passphrase (`sync.py --dry-run FOLDER --new-passphrase`, with the folder `push.py` uses) seals everything again under it, and the next push sends the lot. Devices that remember the old key must open the page again and enter the new passphrase.
- The shell pages are the ones `sync.py` puts in the sealed folder, but they reach the app only by your hand (step 7). `push.py` says so after a run whenever the folder's pages differ from the ones you last copied out. A page not yet updated keeps working against the sealed objects it can read; a new page needs the new copy.
- If the app's `shell/` folder is empty, the owner sees a note that nothing is deployed instead of the page.
- A page left open past the end of its session (7 days, or a changed `SESSION_SECRET`) shows its old content and fails requests with 401 until reloaded; the page is `sync.py`'s, so that warning belongs to it.

To undo things: `node keys-cli.js revoke <id>` stops a laptop key at once (`node keys-cli.js list` shows ids). Changing `SESSION_SECRET` signs everyone out. Removing an address from `ALLOWED_EMAILS` and redeploying locks that person out.

## Tests

```bash
node --test setup/transcript-reader/replit/app.test.js setup/transcript-reader/replit/units.test.js
python3 -m unittest setup/transcript-reader/test_push.py
```

`app.test.js` runs the real handler against a stand-in sign-in provider and a memory store: the allow-list, a refusal on every route when not signed in, forged and expired sessions and ID tokens, the owner's reads and queue writes, upload key refusal and revocation, the accepted bodies, and name traversal. `test_push.py` runs `push.py` against a stand-in endpoint (failures: wrong key, redirect, busy server) and against the real app on a folder store.

## What was not verified

- **Replit Object Storage client.** `store.js` follows the package's documented `{ ok, value, error }` results and is tested against a stand-in client only. If a call differs, that file is the only place to change.
- **The package version.** `package.json` asks for `@replit/object-storage` `^1.0.0`. If Replit cannot install it, add the package from Replit's own package manager and keep the rest.
- **JumpCloud's claims.** The app expects `email` and `email_verified` in the ID token and reads the provider's discovery document. If JumpCloud leaves out `email_verified`, set `OIDC_EMAIL_VERIFIED_OPTIONAL=1` as described above.
- **Deployment visibility.** That "Public" is available to the ShopBack workspace and lets the laptop's upload through is the Marking-Down team's experience, not something checked here.
- **The first real upload's size and time**, and how the phone handles the sign-in redirect.
