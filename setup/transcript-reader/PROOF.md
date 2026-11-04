# Add -> Send now proof

Date: 2026-11-04
Branch: `fm/reader-send-now`

## Regression reproduction

Before the fix, the local reader was opened with the fake Herdr service. After entering `Baseline held message` and clicking Send, the dock showed:

```text
Add: <button ... disabled="">Add</button>
Send: Undo 4
Status: Sending in 4 s · Undo takes it back
```

This reproduced the bug: Add stayed disabled during the Undo window.

## Browser verification after the fix

The same local reader flow was run through Chrome DevTools against the fake Herdr service. The held state reported:

```json
{
  "add": "Send now",
  "disabled": false,
  "title": "Send this message immediately (Cmd+Enter or Ctrl+Enter)",
  "status": "Sending in 5 s · Undo takes it back"
}
```

Clicking Add immediately entered the existing delivery path and restored the dock:

```json
{
  "add": "Add",
  "addDisabled": false,
  "send": "Send",
  "status": "To alpha · idle · sending…"
}
```

The message appeared once in the conversation. The fake Herdr request stayed pending during its guarded clear sequence, so this browser run verifies the Send now transition, delivery-path entry, single visible message, and dock restoration. The timer unit test verifies that releasing the hold cannot send it a second time.

Screenshots:

- `/private/tmp/reader-send-now-browser.RnHSDa/screenshots/01-add-final.png`
- `/private/tmp/reader-send-now-browser.RnHSDa/screenshots/02-send-now-final.png`
- `/private/tmp/reader-send-now-browser.RnHSDa/screenshots/03-add-restored-final.png`

## Automated verification

```text
node --test setup/transcript-reader/*.test.js
582 tests, 582 passed, 0 failed, 1 skipped

python3 -m unittest setup/transcript-reader/test_questionnaire.py setup/transcript-reader/test_message_link.py setup/transcript-reader/test_reader.py setup/transcript-reader/test_parser.py setup/transcript-reader/test_sync.py setup/transcript-reader/test_resident.py setup/transcript-reader/test_cache.py setup/transcript-reader/test_inline_html.py setup/transcript-reader/test_redact.py
494 tests, 494 passed, 0 failed
```

