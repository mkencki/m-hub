# M-HUB

A Windows desktop app that keeps multiple messaging accounts in one window – each in a fully
isolated session – plus text macros with attachments. WhatsApp, Messenger, LinkedIn and
Facebook, with no limit on how many accounts you add.

Interface in **English** and **Polish**. English is the default; switch it in Settings.

**[Polski / Polish version of this README](README.pl.md)**

---

## Why it exists

I built it for my own use: I needed several accounts side by side, each in its own session,
and I publish it because that problem is not mine alone. It is free, and it stays free.

It is a free alternative to **All-in-One Messenger Hub**, which since 2026-07-18 requires a Pro
licence for a second WhatsApp account. An audit of that app turned up two reasons not to buy
it: no reachable entity responsible for the data, and `wppconnect-wa.js` on board – a library
that reaches into WhatsApp Web's internals, which risks a permanent ban on the phone number.

This app does neither. See **[What it will never do](#what-it-will-never-do)**.

## Install

Download the installer from [Releases](https://github.com/mkencki/m-hub/releases). Every
release carries the SHA256 of its installer; who signs the binaries and what the application
does with your data is set out in the [code signing policy](docs/code-signing-policy.md).

> **The installer is not code-signed.** Windows will warn you, and on a clean Windows 11 install
> **Smart App Control will block it outright**. Read
> **[docs/installing.md](docs/installing.md)** before you download – it explains
> which of the two you are seeing and what to do about each.

That is being dealt with: M-HUB is applying to the [SignPath Foundation](https://signpath.org/)
for the free code signing it offers open source projects. Until the application is granted,
releases stay unsigned.

Running from source works even when Smart App Control is enabled:

```bash
git clone https://github.com/mkencki/m-hub.git
cd m-hub
npm install
npm start
```

The repository was renamed to `m-hub` on 2026-09-02, to match the application. GitHub keeps
permanent redirects, so every link published under `mkencki/msg-hub` – including the download
links in older releases – still resolves. Two things are NOT redirected: GitHub Pages sites and
actions hosted in the repository, and this project has neither. The old name must never be
reused for another repository, because that would break the redirects.

### The taskbar icon

Windows takes a pinned button's icon and name from the shortcut it was pinned from, never from
the running window. Pin an application started with `npm start` and you have pinned
`electron.exe`, Electron's own logo included. One command writes a Start menu shortcut that
carries M-HUB's icon and its application identity, so the live window merges into the pinned
button instead of standing next to it:

```bash
npm run shortcut
```

Then pin **M-HUB** from the Start menu and unpin any older "Electron" button beside it. An
installed build needs none of this: its installer writes the same shortcut.

## What it does

| | |
|---|---|
| **Accounts** | as many as you like, each in a `persist:<id>` partition – cookies, `localStorage` and `IndexedDB` fully isolated |
| **Channel rail** | collapses to bare channel colours, expands on hover, pins open; unread count per account |
| **Settings** | add an account, rename it, change its colour, reorder the rail, remove it along with its session |
| **Macros** | `Ctrl+;` opens a searchable palette – arrows to choose, Enter to insert; edit and delete behind a confirmation |
| **Macro editor** | WhatsApp formatting bar, live preview, attachments added and removed in place, tags |
| **Placeholders** | write `{name}` in a macro and it asks you before it inserts; `{date}` fills itself |
| **Attachments** | PDF and mp4 **copied into the app's own storage** – you no longer need the original file; 100 MB limit |
| **Language** | English and Polish, switched in Settings without restarting; the choice survives a restart |
| **Keyboard** | `Ctrl+1`..`Ctrl+9` jump to a channel, `Ctrl+;` opens macros, `Ctrl+Shift+Space` does it from any program, `Ctrl+R` reloads the account you are looking at |
| **Tray** | closing the window keeps the app running and noticing; switch it off in Settings. Autostart really does start hidden |
| **Recovery** | a crashed, hung or stale account offers a reload in the status bar – nothing reloads by itself, because that would throw away a half-typed message |
| **Links** | a link out of a conversation opens in your own browser, not in a window without an address bar carrying your signed-in session |
| **Downloads** | a file from a conversation says when it has landed and offers the folder it landed in; Settings holds the folder and whether you are asked each time |
| **About** | a nameplate at the foot of Settings: version, build date and commit, Electron and Chromium, the profile folder with its size on disk and a button that opens it, licence and source |

Macros and attachments live in `%APPDATA%\M-HUB` (`macros.json` and the `att/` directory),
accounts in `accounts.json` next to them. Deleting a macro or detaching a file cleans the storage,
so a multi-megabyte video never lingers on disk without an owner.

Renaming an account **does not touch its identifier**, because the session partition is built from
it (`persist:<id>`) – fixing a typo will not sign you out.

## The services

| | |
|---|---|
| **WhatsApp** | as many accounts as you like, each its own sign-in |
| **Messenger** | messenger.com |
| **LinkedIn** | the whole service – feed, jobs, learning, messaging – not only the message box |
| **Facebook** | the whole service |

Facebook and Messenger are **separate accounts with separate sign-ins**, even for one Meta
identity, because each account is its own session. Signing in to both means two sign-ins and,
on a Meta account, possibly two security reviews.

**Counts are only shown where the service puts one in its page title**, and only where that
number means what a count next to a channel is read to mean: waiting conversations. WhatsApp
and Messenger do. LinkedIn's number is the sum of eight different badges – feed, jobs,
notifications, messaging – so it shows none; Facebook's format could not be confirmed, so it
shows none either. Nothing here reads the contents of a page to find out.

**Notifications are per account.** Messengers may interrupt straight away; LinkedIn and
Facebook stay quiet until you allow them in that account's settings, because a whole service
notifies about reactions, groups, pages and birthdays, not only about somebody writing to
you. You can silence a messenger the same way.

**Every account is loaded and stays loaded**, which costs about 250 MB each once its page is
up – measured at 754 MB for one account, 1266 MB for three and 1760 MB for five. That is
deliberate: an account that is not loaded cannot notify you or count anything, which is the
whole point. Five accounts want about two gigabytes; decide accordingly.

> **Going back a version deletes new accounts.** A build that predates LinkedIn and Facebook
> does not recognise them, silently drops them when it reads `accounts.json`, and the next
> save writes the shortened list. If you downgrade, those accounts and their sign-ins are
> gone.

## The interface

The app wraps someone else's UI, so its own chrome is deliberately desaturated: the only saturated
colour in the window is the colour of the active account. It outlines the whole working area,
because the one real risk this product carries is **mistaking which account you are in** – sending
something from your private WhatsApp to a work contact, or the reverse. The new-account form
suggests a colour that is not yet in use, so no two accounts look alike.

Channels sit in a rail on the left rather than in tabs along the top: WhatsApp Web and Messenger
both have their own header, and a bar above a bar turned into visual mush. The rail collapses to
48 px and expands on hover; the pin button at the top holds it open, and that choice survives a
restart. Expanding **pushes** the account view aside instead of covering it – the views are a
native layer above the renderer, so an overlay drawn in HTML would hide *underneath* the messenger
page.

Typefaces are system ones, with **not a single network request**: this app grew out of a privacy
audit, so fetching fonts from someone else's server on every start would contradict it.

## What it will never do

Three boundaries. They come from the audit and are not negotiable:

1. **It does not send messages.** A macro prepares the content and stops. Enter belongs to you.
2. **It does not load `wa-js`, WPPConnect, Baileys or anything of that family.** Pages load exactly
   as Meta serves them.
3. **It inserts through the clipboard only.** No DOM manipulation of the loaded pages, attachments
   included.

Rules 1 and 2 are enforced by tests – [`tests/insertion.test.js`](tests/insertion.test.js) and
[`tests/boundaries.test.js`](tests/boundaries.test.js) fail the moment someone adds a forbidden
dependency or a sending path.

### The log

The app writes a plain-text log to `%APPDATA%\M-HUB\logs\`, reachable from the tray menu.
It exists so that helping someone whose app will not sign in does not require sitting at their
computer.

**It records kinds of event and error codes, and nothing else.** No message text, no macro
content, no attachment names, no page titles and no conversation names. An account appears by
its identifier, never by the name you gave it – that name is frequently a person. This is not
a promise about how the logging code is written: `src/main/log.js` writes only the fields on a
short declared list and silently drops everything else, and
[`tests/log.test.js`](tests/log.test.js) fails if that list grows without someone meaning it to.

The file is capped and rotated, keeping at most one older copy, so it cannot fill a disk.
A log you can read, and choose to send, is the opposite of telemetry.

## Development

```bash
npm test          # Vitest – logic
npm run test:e2e  # Playwright + Electron – operator paths on a real window
npm run dist      # portable .exe (builds locally)
```

The **installer** is built by [CI](.github/workflows/build.yml), not locally: NSIS generates its
uninstaller by *running* the freshly built installer, and Smart App Control kills that. The runner
has no Smart App Control, so `npm run dist:installer` belongs there.

Source is plain JavaScript ESM, no bundler, and everything – file names, identifiers, comments,
JSON keys and test descriptions – is in English. It was not always: the app began as a private tool
written in Polish, and version 1 of the on-disk format still carries Polish keys. Both spellings
are accepted on read and version 2 is written back on the next save, so upgrading costs nobody
their accounts or macros. That contract is pinned by [`tests/migration.test.js`](tests/migration.test.js).

Layout:

| Path | What lives there |
|---|---|
| `src/main/` | the main process: accounts, macros, views, the IPC bridge, the window shell |
| `src/renderer/` | the window's own interface – HTML, CSS and the renderer script |
| `src/shared/` | code both processes need: the translation core and the dictionaries |
| `src/preload/` | the context bridge (CommonJS – Electron does not load ESM here) |

UI strings live in [`src/shared/locales/`](src/shared/locales/) under keys rather than in the code.
A unit test fails the moment the two dictionaries drift apart, so a new string cannot land in one
language and show a bare key in the other.

## Documentation

- [`docs/installing.md`](docs/installing.md) – what Windows does to an unsigned installer, and why
- [`docs/typography.md`](docs/typography.md) – the characters the two languages use, and the test that enforces them
- [`docs/design.md`](docs/design.md) – the design: audit, architecture, data model, security boundaries, rejected alternatives

## Stack

Node 26, Electron 43, plain ESM JavaScript, no bundler. Vitest, Playwright, electron-builder.

## Licence

[MIT](LICENSE) © 2026 Marek Kencki
