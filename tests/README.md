# Tests

These cover the parts of the app where a silent failure would cost field data:
offline behaviour, the backup round-trip, the sync merge rules, and the
security rules.

## Prerequisites

    npm install -g playwright firebase-tools

Set `CHROME` to a Chromium binary, and serve the app so it sits at a
`/ct-manager/` path (matching how GitHub Pages serves it):

    mkdir -p /tmp/serve && ln -s "$PWD/.." /tmp/serve/ct-manager
    (cd /tmp/serve && python3 -m http.server 8769)

## Running

`merge.test.js` needs nothing else — it is pure logic:

    node merge.test.js

`offline.js` and `backup.js` need only the web server above:

    node offline.js
    node backup.js

`twodevice.js` and `rules.test.js` need the Firebase emulators. Copy the
rules from the parent directory, adding a second address to each allow-list
so a colleague can be simulated, then:

    firebase emulators:start --project ct-manager-test --only auth,firestore,storage
    node twodevice.js
    node rules.test.js

## What each one covers

| File | Covers |
|---|---|
| `merge.test.js` | Three-way merge: disjoint edits both survive, same-field edits are flagged, an edited record outlives a remote delete |
| `twodevice.js` | Two devices with separate storage: push, pull, photo upload and download, concurrent offline edits, conflicts, delete propagation |
| `rules.test.js` | An allow-listed account can read and write; an account not on the list is refused both |
| `offline.js` | Service worker precaches the app and SDK; jobs and fields survive a fully offline reload |
| `backup.js` | Export, wipe both stores, import — jobs and photo bytes come back and render |

## Environment overrides

`CHROME` (required), `APP_URL`, `PLAYWRIGHT` — the last if the Playwright
module is not resolvable by name.
