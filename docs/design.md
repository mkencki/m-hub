# M-HUB – design

Written: 2026-08-23
Status: approved, implemented
Translated from the Polish original: 2026-08-24

## 1. Purpose

One window on Windows for three messenger accounts: Messenger, a private WhatsApp and a
work WhatsApp. It replaces the paid All-in-One Messenger Hub, which – after the grace
period for existing users ended on 2026-07-18 – requires a Pro licence to run a second
WhatsApp account.

This project follows an audit of that application. The audit showed that the only feature
actually needed – several accounts of the same platform – comes down to isolated browser
profiles and requires no reverse engineering whatsoever. It also showed that the other app
loads `wppconnect-wa.js` (WPPConnect/wa-js v3.23.2), a library that reaches into the
internals of WhatsApp Web. That breaches WhatsApp's terms and risks a permanent ban on the
phone number. The operator's work number is one of the accounts in question, so avoiding
that entire category of tooling is an overriding requirement, not a preference.

**Widened 2026-08-25.** An account no longer has to be a messenger. See section 2,
*Whole services*: the mechanism the audit identified – an isolated browser profile in a
native view – turns out to be indifferent to what the profile holds, and the operator has
uses for two sites whose messaging is only one page among many. The purpose above still
describes what the application is *for*; it no longer describes the limit of what it may
hold.

## 2. Scope

### In scope

- three (eventually any number of) accounts in one window, each in an isolated session
- a configurable account list in a JSON file, plus an add-account screen in the app
- macros: saved fragments of text with WhatsApp formatting, and attachments
- dark theme, remembered window size and position
- a system tray icon and start-with-Windows
- system notifications and an unread count on the taskbar icon

### Out of scope

- locking the window with a PIN or Windows Hello (rejected by the operator)
- separate rules for the work account, a mute schedule (rejected)
- a notification bridge to `ntfy` (deferred; returns only if native notifications fail)
- any automatic sending of messages (forbidden – see section 7)
- contact export, chatbots, AI replies (the `wa-js` category, forbidden – see section 7)
- a web version and access from the work laptop (withdrawn by the operator, 2026-08-23)

### Whole services

*Amended 2026-08-25, by the operator's decision.*

An account may host a **whole service**, not only its messaging surface. LinkedIn and
Facebook enter the design as full sites – `linkedin.com`, `facebook.com` – rather than as
`/messaging/` and `/messages/`. Messaging on those two is one page inside a site the
operator reads anyway, and splitting it off would mean keeping the same login open twice.

This is a change of what the product *is*, not a longer list of URLs. A messenger is a
single screen the user watches; a social network is a place they navigate. Four
consequences follow, and none of them is optional:

1. **A navigation and child-window contract becomes a precondition, not a nicety.** A whole
   service is full of outbound links, and its sign-in legitimately crosses origins
   mid-flow. Without a policy the application is a browser with no address bar and
   notifications granted in advance – a worse place to click a stranger's link than the real
   browser next to it. Each platform therefore declares the hosts it owns
   and the hosts it authenticates through. Anything else opens in the system browser.
   Naive rules break this in both directions: blocking every off-origin navigation breaks
   OAuth, and allowing any host that merely *contains* the service name admits
   `facebook.com.example.invalid`.
2. **The unread badge stays honest and therefore stays absent.** `unreadFromTitle` reads a
   leading `(N)` from the page title, which is a convention of Meta's two messengers, not a
   general mechanism. Every other wrapper in this category reads the count by injecting a
   script that scrapes the page; section 7 forbids that, and the prohibition does not bend
   for a service the operator happens to want. A service whose title carries no count gets
   **no count**, and relies on the system notification instead. A badge that guesses is
   worse than a blank one.
3. **Notifications become a per-account matter.** A messenger notifies when a person writes
   to you. A social network notifies about reactions, groups, pages, birthdays and things
   it would like you to look at. Granting the permission once for every account, as the
   application does today, does not survive contact with a full Facebook.
4. **Platforms remain a closed list.** The obvious generalisation – an account type that
   takes any URL – is refused. It would turn a reviewed allowlist into an uncontrolled
   browser carrying live sessions, and it is a security regression wearing the costume of
   flexibility. Adding a service stays a deliberate edit to this design.

Section 7 is untouched by any of this. A whole service is still a page loaded exactly as
its owner serves it, with nothing injected into it.

## 3. Architecture

A single Electron application, run locally. No server, no containers, no dependency on any
existing infrastructure.

```
main window (BrowserWindow)
├── channel rail + macro panel          ← renderer, plain HTML/CSS
├── content area
│   ├── WebContentsView  session persist:acc-messenger  → messenger.com
│   ├── WebContentsView  session persist:acc-wa-priv    → web.whatsapp.com
│   ├── WebContentsView  session persist:acc-wa-work    → web.whatsapp.com
│   ├── WebContentsView  session persist:acc-linkedin   → linkedin.com/feed/
│   └── WebContentsView  session persist:acc-facebook   → facebook.com
└── child window, on demand             ← a sign-in the service opens for itself,
                                          in the SAME session, titled by its origin,
                                          sandboxed, and gone when its opener is;
                                          its own Back, Forward and Reload
```

Each view costs about 250 MB once its page has loaded – measured 2026-08-25 at 754 MB for
one account, 1266 for three and 1760 for five, on a machine with 16 GB. Every account is
loaded at startup and stays loaded, deliberately: an account that is not loaded delivers no
notification and reports no count, which is the entire reason this application exists.
Whether five accounts are worth two gigabytes is the operator's decision, so the number is in
the README rather than hidden behind a lazy-loading switch.

*Amended 2026-10-17, by the operator's decision.* An account stays loaded **unless the operator
puts it to sleep by hand.** The log the application keeps since 0.6.0 put the price of an awake
account higher than the figure above: 300–511 MB of private memory for a WhatsApp, 324–408 for
Messenger and about 700 for a settled Facebook (2026-10-17 and 18, `account-memory`), with the
whole application at about 2.0 GB on a laptop left with 450 MB to spare during heavy work. Sleep
answers that, and it is only acceptable as the opt-out it is:

- **Manual and nothing else.** No timer, no idle rule, no memory threshold puts an account to
  sleep. A sleeping account delivers no notification and reports no count, so the choice to give
  that up is the operator's, made for one account at a time from its channel's menu.
- **Visible.** The rail marks a sleeping account as asleep where its count would be. A blank
  there would read as "nothing waiting", which a sleeping account cannot know.
- **Every account wakes at the start.** Sleep is meant for a spell of heavy work, not for good,
  and does not survive a restart.
- **Offered back, never woken behind the operator's back.** The application lives in the tray
  and a laptop resumes rather than restarts, so the start alone would not stop an account being
  forgotten for days. After the computer wakes, and when the window comes back to the front, the
  status bar says how many accounts are asleep and offers to wake them.
- **Sleep is the view closed, and waking is a load.** Electron 43 cannot discard or freeze a page,
  so sleeping closes the account's view and waking creates it again on the same `persist:`
  partition: the sign-in, cookies and storage survive, the page starts from its address. A
  notification shown before the account fell asleep wakes nothing when clicked – the page it came
  from is gone.

What sleeping frees is an estimate until 0.7.0 has been used: about what the account cost awake,
released up to half a minute after the close while a service worker keeps the process alive.
Sleeping both WhatsApps and Facebook while working in Messenger is expected to free about 1.3 GB.
The measured gain replaces this paragraph's estimate in a later change.

Isolation comes from a separate session partition per account. Two WhatsApp accounts
see each other as two independent browsers – they share no cookies, no `localStorage` and
no `IndexedDB`. This is the heart of the application and the one mechanism without which
there is no product.

`WebContentsView` is Electron's current API for multiple views; `BrowserView` is deprecated
and the `webview` tag is discouraged by Electron itself. For content that needs its own
session, the documentation points directly at `WebContentsView` with a separate partition.

## 4. Components

Each component has one responsibility and can be tested on its own.

### 4.1 `accounts` – the account registry

Reads and writes the account list and assigns partition identifiers. Knows nothing about
windows.

### 4.2 `views` – the view manager

Creates a `WebContentsView` per account, attaches its session, sets the `User-Agent`,
governs geometry as the window resizes, switches the active view, reloads an account in one of
three ways – ordinary, past the cache, or by restarting its renderer – and steps an account back,
forward or to its start page. Puts an account to sleep by closing its view, asking the page first,
and detaches the view only once Electron reports it destroyed; wakes it as a new view on the same
partition. Knows nothing about where the account list came from.

### 4.3 `macros` – the macro store

Holds macro definitions and copies of attachments, and searches by name and content. Knows
nothing about how a macro reaches a chat.

### 4.4 `insertion` – putting content in

Places text or a file on the clipboard and triggers a paste in the active view. The only
component that touches the clipboard. It does not send messages – ever (section 7).

Text goes through Electron's `clipboard.writeText`. A file needs the `CF_HDROP` format –
the one Windows sets on `Ctrl+C` in Explorer and the one Chromium hands to a page as
`DataTransfer.files`. Electron's `clipboard.writeBuffer('FileNameW', …)` handles only a
single file and gives no assurance that Chromium will interpret it that way, so we use the
method **verified empirically in stage 0**: calling
`powershell.exe -NoProfile -STA -Command "Set-Clipboard -LiteralPath …"`.

A catch found in stage 0: `Set-Clipboard -LiteralPath` and `Get-Clipboard -Format` exist
**only in Windows PowerShell 5.1**. PowerShell 7 has neither parameter, so the call must
name `powershell.exe` explicitly, never `pwsh`.

Cost: starting a process, on the order of hundreds of milliseconds. If that turns out to be
noticeable, the alternative is a native module setting up a `DROPFILES` structure – a purely
performance decision, not a functional one, and taken only after measurement.

### 4.5 `shell` – the window shell

Window, tray, autostart, dark theme, remembered layout, notifications, badge.

## 5. Data model

Everything lives in the application data directory (`app.getPath('userData')`).

### 5.1 `accounts.json`

```json
{
  "version": 2,
  "accounts": [
    {
      "id": "acc-wa-work",
      "name": "WhatsApp work",
      "platform": "whatsapp",
      "url": "https://web.whatsapp.com/",
      "color": "#2f7d5b"
    }
  ]
}
```

`id` is immutable – it serves as the partition name (`persist:acc-wa-work`). Changing `id`
means losing the session, so the interface does not allow editing it. `platform` selects the
default address and icon; `url` can be overridden by hand.

> Schema version 1 used Polish key names (`wersja`, `konta`, `nazwa`, `platforma`, `kolor`),
> because the app began as a private tool. Both spellings are accepted on read and version 2
> is written back on the next save, so upgrading costs nobody their accounts. See
> `tests/migration.test.js`.

### 5.2 `macros.json`

```json
{
  "version": 2,
  "macros": [
    {
      "id": "mac-client-area",
      "name": "Guide – Client Area",
      "text": "*How to add a driver:*\n\n1. Sign in\n2. Open the Drivers tab\n\n> Get in touch if anything is unclear.",
      "attachments": ["att/4f2a-guide.pdf"],
      "tags": ["client-area", "guide"]
    }
  ]
}
```

The `text` field stores **plain text with WhatsApp markers**, not rich text. WhatsApp
supports bold (asterisks), italics (underscores), strikethrough (tildes), a code block
(triple backticks), inline code (single backticks), a quote (greater-than at the start of a
line), a bulleted list (dash or asterisk plus a space) and a numbered one (digit, dot,
space). It has no underline. The markers behave identically on desktop and on the phone.

A consequence accepted deliberately: the markers are WhatsApp's. The same text pasted into
Messenger will show raw asterisks. Macros are aimed mainly at clients on WhatsApp, so
WhatsApp is the target format.

### 5.3 The attachment store

An attachment added to a macro is **copied** into the `att/` directory in the app data,
under a name prefixed with a UUID. This delivers the operator's requirement: files should
live in the application, so they need not be hunted down on disk each time. Deleting a macro
deletes the copies nothing else links to.

The interface shows the total size of the store. Single-file limit: 100 MB – safely below
WhatsApp's own limits and above a typical instructional video.

## 6. Flows

### 6.1 Application start

1. Read `accounts.json`; with no file, run the first-account wizard.
2. Create a view per account, with a `persist:<id>` session and an overridden `User-Agent`.
3. Restore the window size and position and the last active channel.
4. Inactive views load in the background so notifications work for every account – including
   one the operator had put to sleep before the restart, since sleep lasts until the next start
   at most (section 3, amended 2026-10-17).

### 6.2 Using a macro

1. The macro panel (`Ctrl+;`) with search across name and content.
2. Choosing a macro inserts the text into the message box of the active chat.
3. If the macro has an attachment, it goes in as a separate step, after the text.
4. **The application stops there.** The operator sends the message by pressing Enter.

### 6.3 Adding an account

An "Add account" screen: name, platform from a list, optionally a custom address and channel
colour. Saved to `accounts.json`, a view created, and sign-in by QR code or the platform's
own form – exactly as in a browser.

## 7. Security boundaries

Three rules the design does not cross. They follow directly from the audit of 2026-08-23.

**7.1 The application does not send messages.** A macro prepares the content and stops.
Preparing a message is user behaviour; sending it automatically would be the automation the
audit warned about. The boundary is here, not further out.

**7.2 The application does not load `wa-js`, WPPConnect, Baileys or any related library.**
No access to the internals of any page an account loads. Pages load exactly as their owner
serves them.

**7.3 Content is inserted through the clipboard.** A clipboard write and a paste are
indistinguishable from doing it by hand. Stage 0 settled this rule positively and **without
exceptions** – see section 9. The application does not manipulate elements of a loaded page
for any purpose, attachments included.

Beyond these rules the application is an ordinary browser with tabs.

> **Generalised 2026-08-25, alongside the *Whole services* amendment in section 2.** Rules
> 7.2 and 7.3 were written naming WhatsApp, because at the time WhatsApp was the only page
> whose internals anyone would have been tempted to reach into. Now that an account may
> host any service on the list, a prohibition that names one site would have left the
> others outside it – which is the opposite of what these rules are for. The wording is
> widened to every page an account loads; nothing is relaxed, and the reason is unchanged.
> The temptation the rules exist to refuse is the same one in every case: reading a page's
> DOM to obtain an unread count. Section 2 states the consequence plainly – a service whose
> title carries no count gets no count.

## 8. Error handling

| Situation | Behaviour |
|---|---|
| `accounts.json` damaged | a backup copy alongside it, start with an empty list, message shown |
| no network | the view shows the platform's own state; the app does not intervene – F5 or the channel menu brings the page back once the network does |
| a page refuses to be left (an unsent draft) | said in the status bar by account; an offer to discard only when the refusal answers a reload or a step just asked for, and to sleep anyway when it answers a sleep – the account stays awake until then |
| an account the operator put to sleep | no notification and no count; the rail says "asleep" where the count would be; the status bar offers to wake it after the computer resumes and when the window comes back, and nothing wakes it by itself |
| WhatsApp refuses the client (`User-Agent`) | an explicit message suggesting an update |
| attachment file missing from the store | the macro is marked incomplete, the text still works |
| file over the limit | refused, with the size and the limit reported |
| session signed out | the view shows a QR code; the app does not intervene |

## 9. Stages

**Stage 0 – settling the clipboard question. DONE 2026-08-23, result POSITIVE.**

The question: does WhatsApp Web accept a file pasted from the Windows clipboard (`CF_HDROP`)?

How it went. The first layer was checked by reading the artefact, not by the absence of an
error: `Set-Clipboard -LiteralPath` in Windows PowerShell 5.1, then `Get-Clipboard -Format
FileDropList` confirmed one file on the clipboard with the text layer empty. The second layer
was checked by hand by the operator, in Edge on `web.whatsapp.com`, in a chat with himself,
outside the audited application (that one loads `wa-js` and would have given a false positive).

Material: a 10.23 MB instructional video (signature `ftypmp42`) and a 0.74 MB PDF – real
files of the same class as future macro content. Sizes were chosen below WhatsApp's limits so
that a refusal could not be blamed on file size.

Result: **both types pasted correctly.** The video showed a player with a caption field, the
document a file card. A visible thumbnail strip with a button to add another attachment
confirms that several files can be inserted one after another.

Consequences: substituting a file into the page's form field is **not needed and does not
enter the design**. Rule 7.3 applies without exception. Stage 3 builds the clipboard path only.

**Stage 1 – the core.** `accounts`, `views`, `shell`. Three accounts, isolation, channels,
`User-Agent`, dark theme, window layout, tray, autostart, notifications.

**Stage 2 – text macros.** `macros`, `insertion`, the panel with search, the editor with a
formatting bar and a preview, the `Ctrl+;` shortcut.

**Stage 3 – attachments.** The `att/` store, insertion per the result of stage 0.

**Stage 4 – distribution.** `electron-builder`, a single installer, autostart.

**Stage 5 – staying alive. DONE 2026-08-25.**

The app is asked to sit in the tray all day and notice things. Everything here serves that,
and each item below was measured before it was changed rather than assumed.

- **The rail no longer closes under the operator's own cursor** when another window takes the
  foreground. Chromium reports that as a mouseleave carrying the position the pointer had all
  along; `acceptHoverReport` in `shell.js` weighs the report, and returning to the foreground
  asks the renderer where the pointer is now, because holding a report back loses it.
- **Accounts in the background run at full speed.** `backgroundThrottling` was unset, so a
  100 ms timer ticked 10 times in ten seconds in a hidden view instead of 100 – and hiding the
  window to the tray put the ACTIVE account in that state too. *Amended 2026-10-17:* this holds
  for every awake account and stays so. Throttling is not how memory is saved here; an account the
  operator puts to sleep has no page left to throttle (section 3).
- **A second copy over the same profile gives up** instead of fighting the first over the
  cookie stores, where the loser loses its sign-in.
- **The window button puts the app in the tray**, on by default, switchable in Settings.
  Autostart passes `--hidden` on the command line and the window is built unshown;
  `openAsHidden` is macOS-only and did nothing here.
- **Ctrl+1..9 selects a channel by position** and **Ctrl+Shift+Space** raises the window and
  opens the macro palette from anywhere. A refused global shortcut is reported rather than
  left silent.
- **Clicking a notification lands on the account it came from.** A view taking focus asks the
  renderer to switch – but not until its first load has settled, because a view takes focus
  while it is being created and the app would otherwise start on whichever account happened
  to finish last.
- **A stale or dead account can be reloaded** without restarting the others: Ctrl+R, and a
  button in the status bar offered after a crash, a hang, a failed load or waking from sleep.
  Nothing reloads on its own, because reloading throws away a half-typed message.
- **A local log** in `%APPDATA%\M-HUB\logs\`, reachable from the tray. It writes only the
  fields on a declared list and drops everything else, so it can be sent to somebody. Page
  titles are excluded precisely because they carry contact names.
- **The clipboard session survives a bad day**: stderr is drained, a timed-out process is put
  down rather than reused, and a clipboard that refuses a file is reported instead of
  escaping the handler.

**Stage 5.6 – the navigation contract** is called out separately because stage 7 depends on
it. Every address now has a declared place to open: the account view, a controlled child
window, the system browser, or nowhere. The decision rests on host lists a platform declares,
never on how a window was asked for – a sign-in popup and a link to an article cannot be told
apart by disposition or features. Host matching is a suffix comparison on a dot boundary, the
external list is consulted first because link shims live on the service's own domain, and only
`http:` and `https:` are ever handed to the system.

*Amended for 0.6.1.* A step back or forward does not pass through `will-navigate`, and does not
need to: the history holds only entries the view has already committed, each of which passed the
rules on its way in. Steps go only where `canGoBack` and `canGoForward` allow – never
`goToOffset`, which would walk into the entries Chromium marks as skippable because a page added
them before anybody touched it. A window a page opened keeps its own history and its own Back,
Forward and Reload, and it can hand a page of the service to the account view when the operator
asks; a sign-in never, because it answers back to the window that opened it.

**Stage 6 – macros 2.0. DONE 2026-08-25**, except 6.5, which needs the operator's consent
because it would change the LETTER of rule 7.3, and 6.7, which waits for stage 7.

- **Tags stop being a field only the file format knew about.** The model has carried them
  since stage 2 and the search box says "name, content or tag", but no screen ever set one.
  The editor now has a field, the palette shows them, and clicking one searches for it. Case
  is settled on the way in, because search settles it on the way out.
- **Placeholders.** Any `{name}` in a macro becomes a question asked BEFORE anything is
  written anywhere – cancelling leaves the clipboard untouched. `{date}` and `{data}` fill
  themselves. A macro without placeholders passes through unchanged.
- **The status bar stopped claiming an insertion it cannot see.** Measured: with no editable
  field focused, `webContents.paste()` does nothing and reports nothing, while the message
  said "Inserted". Finding out for certain would mean reading the page, which rule 7.3
  forbids, so the sentence says what is known and asks the operator to check the box.

One thing the plan expected to build turned out to be there already and is now pinned by a
test rather than rebuilt: the palette header has named the destination account since stage 2.

The other, the keyboard returning to the account after an insertion, was first written up as
already working and that was **wrong** – measured in a state nobody is ever in, with the app's
window not in front. A window that is not in front has no keyboard to hand anybody. Measured
properly it returns in one of the two states and not the other, depending on which
`webContents` held focus when the palette opened, so the application now asks for it instead
of relying on what closing a `<dialog>` happens to do.

**Stage 7 – whole services. DONE 2026-08-25**, except Telegram, which stays out.

LinkedIn and Facebook can be added like any other account, and stand entirely on the
navigation contract from 5.6: a full service is a few hundred outgoing links, each of which
would otherwise open a bare window carrying the account's signed-in session.

- **LinkedIn is entered at `/feed/` on the www host**, never at the apex – measured twice
  with curl, the apex answers "Checking your browser - reCAPTCHA". Its sign-in hosts are
  declared, because they genuinely leave the service: Apple's opens a window and answers
  through `postMessage` to its opener, so it can neither go to the system browser nor be
  denied.
- **Neither service shows a count.** `unreadFromTitle` now reads "(99+)" correctly – it used
  to return zero, so the badge vanished exactly when an account was busiest – but LinkedIn's
  number is the sum of eight badge sources, and Facebook's 2026 format could not be confirmed
  at all. Both are one word from being turned on and the reason sits on the entry.
- **Notifications are controlled per account**, which was the condition for shipping
  Facebook. Messengers may interrupt out of the box, whole services stay quiet until asked,
  and the account overrides its platform in either direction.

**A one-way door.** An `accounts.json` holding a `linkedin` or `facebook` account, opened by
a build that predates them, is silently dropped by the validation filter in `loadAccounts` –
and the next save writes the shortened list. Going back a version deletes those accounts and
their sign-ins. This is in both READMEs and belongs in the release notes.

**Telegram is not here.** It works, its session stands on its own, and its client is GPLv3 –
but its title says "3 notifications" only while the tab is idle, blinking once a second, and
one of the two clients reports a delta rather than a total. It was optional in the plan, it
needs an account to verify, and a closed platform list is only worth anything while every
entry on it has been seen working.

**Stage 8 – four things the operator found in a day of use. DONE 2026-08-25.**

**0.3.0 had no release because it had no tag.** The workflow publishes on `refs/tags/` and
nothing else, and the version in `package.json` was raised without one being pushed. Not a
failure of the pipeline – a step nobody took. A release now also says what the version changes:
the body is the section for that tag cut out of `docs/release-notes.md`, followed by the
installation caveats, and a tag with no section fails the step instead of publishing an empty
body.

**A pinned button takes its icon from the shortcut, never from the running window.** Measured
2026-08-25: the pinned `Electron.lnk` targeted `node_modules\electron\dist\electron.exe` with
`IconLocation ",0"` – the atom, straight out of the target – and the `msg-hub.lnk` already in
the Start menu pointed at `build\ikona.ico`, a file gone since the repository was anglicised.
Installing the packaged build is the usual answer and is not available on a machine with Smart
App Control, where running from source is the supported path. So `npm run shortcut` writes the
shortcut instead, with the icon and – through the shell property store, because `WScript.Shell`
has no idea it exists – the same AppUserModelID the application sets at startup. Without the
identity the live window will not merge into the pinned button, and the taskbar carries two.

**The icon carries nine frames.** It had one, 256 square, and Windows draws it at 16, 24 or 32
everywhere that matters. `build/ico.mjs` assembles the `.ico` from the PNG set in
`src/renderer/icons`, which is the one place the artwork lives; `build/icon.ico` is generated
from the same bytes for electron-builder, and a test fails if the two drift apart. The set is
under `src/` because `package.json` packs `src/**/*` and nothing else – an icon in `build/`
reaches the installer and never reaches the installed application.

**The badge stopped following the page's blink.** A page with something waiting alternates its
own title – "(1) Messenger", "Messenger", about once a second – and the count read that
literally, so the overlay appeared for a second and vanished for the next. Nothing in the path
from a title to the badge has a clock, which left the page as the only candidate; the same
behaviour is recorded above as one of the reasons Telegram is out. The latch in
`src/main/unread.js` is one-sided: a count going UP is shown at once, a zero is believed only
after three seconds of zeros. Measured after: 40 of 40 samples over ten seconds kept the count
while the page blinked every 0.9 s, and a page that genuinely went quiet cleared it in 2583 ms.
The timer in `refreshBadge` is the part that is easy to omit – a page that stops blinking stops
sending titles, so a held zero has nothing coming to release it.

**A download says how it ended.** The handling was one line announcing the start, and nothing
ever asked the item how it went, so "Downloading …" stayed on the bar with the file already on
the disk. It now ends: saved, with a button to the folder it landed in; or cancelled or
interrupted, with which. A success takes itself away after eight seconds, a failure does not.
The identity carried by a message is what makes that safe – a timer hides only the message it
put there, never the crash report that took the bar over in the meantime. Settings gained the
folder and the "ask every time" switch, which starts ON because asking is what Electron already
does when no path is set. Turning it off means the application sets the path, and from that
moment Chromium stops numbering repeated names – hence `uniquePath`, or the same attachment
downloaded twice would land on top of itself. "Show in folder" is given the id of a download
this process recorded, never a path: `showItemInFolder` with an argument a page could choose
would point Explorer at anything on the disk.

**What Explorer does with a folder it is handed.** "Show in folder" was asked to open a tab in
an Explorer window that is already up, and a new window only when none is in front. That
decision belongs to the shell, not to this application: `shell.showItemInFolder` calls
`SHOpenFolderAndSelectItems`, and what happens next is Explorer's business. So it was measured
rather than assumed – Windows 11 build 26200, one call per state, counting top-level
`CabinetWClass` windows and the `Shell.Application` entries beside them:

| Before the call | After |
|---|---|
| an Explorer window open, not in front, showing another folder | a NEW window, 1 → 2 |
| an Explorer window in front, showing another folder | a NEW window, 2 → 3 |
| a window already showing the target folder | that window, brought forward. 3 → 3 |
| no Explorer window at all | not measured – it would have meant closing the operator's own |

So the tab never happens: this build opens a window whether or not Explorer is in front, and no
setting for it exists under `Explorer\Advanced` (`OpenFoldersInNewTab` and `TabsEnabled` are
both absent, `SeparateProcess` is 0). What the operator asked to avoid, though, does not happen
either – **windows do not pile up**, because a folder already open is reused and brought
forward, which is the case that repeats when files keep landing in one download folder.

**Forcing the tab anyway: measured, then refused.** The operator asked to see the cost before
deciding, so a prototype was built and run rather than estimated. Three routes exist and two of
them do not do what their names suggest:

| Route | What it actually did |
|---|---|
| the `opennewtab` verb – it really is registered under `HKCR\Folder\shell` | invoked from outside Explorer it **returns success and does nothing**. The key carries `OnlyInBrowserWindow` and a `DelegateExecute` handler, and `Shell.Application` does not even list the verb among a folder's own |
| `IShellWindows` → `Navigate2` | **no tab**: it replaces the contents of the window the operator was looking at. Measured, one window went from folder A to folder B, count unchanged |
| driving Explorer's keyboard – `Ctrl+T`, `Ctrl+L`, the path, Enter | **works**: windows 2 → 2, tabs 3 → 4, on the right folder, with a name containing brackets surviving the escaping |

So a tab is reachable only by typing into somebody else's window, and it costs more than the
window it saves. The prototype came to 99 lines, 37 of them P/Invoke, plus roughly 50 more to
wire in with a fallback and a switch – but the line count is the least of it:

- **the file stops being selected.** `showItemInFolder` selects it; the tab route has to reach
  it by type-ahead in the file list, and the measurement selected TWO items instead of one.
- **it types on the operator's keyboard.** Guarded – the script sends nothing unless the window
  it raised really reached the foreground – but that is the nature of the thing, not a detail.
- **it cannot be covered by the gate.** Playwright cannot see Explorer, and a CI runner has no
  Explorer window at all, so on CI only the fallback would ever run. Everything else here is
  tested.

Refused on 2026-08-25 with those numbers in hand. `showItemInFolder` stays.

**Stage 9 – the name. DONE 2026-08-26.**

The application is called M-HUB. What that costs is not obvious from the field being changed,
so it was measured first, on a throwaway Electron app rather than on this one: with only
`name` in package.json, `app.getName()` returns it and the profile sits in `%APPDATA%\<name>`;
add `productName` and the name, the profile directory AND the token Electron writes into the
default User-Agent all follow it. One field, three consequences.

| | before | after | why |
|---|---|---|---|
| window, tray, shortcut, installer | msg-hub | **M-HUB** | the point of the exercise |
| profile directory | `%APPDATA%\msg-hub` | `%APPDATA%\M-HUB` | follows `productName`; **not migrated** – see below |
| User-Agent token | `msg-hub/0.4.0` | removed | it was removed before too, by a literal |
| `appId` | `pl.kencki.msghub` | unchanged | NSIS derives the installation's GUID from it |
| repository | `mkencki/msg-hub` | unchanged **at the time** | every published release linked through it |

**Both of those decisions were reversed later.** The repository was renamed to `mkencki/m-hub`
on 2026-09-02 – GitHub keeps permanent redirects, so the release links written under the old
name still resolve – and 0.5.3 does carry a profile across: `src/main/profile.js` moves what an
older version left in `%APPDATA%\msg-hub`, sessions included, guarded by the absence of
`accounts.json` in the new profile. The paragraph below records why it was not built in 0.5.0,
which is still the reason 0.5.0 shipped without it.

**No migration, by the operator's decision.** The profile moves with the name, and the 805 MB
left behind – three signed-in sessions, one macro, its 4.7 MB attachment – were deleted
outright before the release rather than carried across. A migration was designed and costed
(a guarded move, a fallback to the old directory, and a guard against `--user-data-dir`, which
would otherwise have dragged a real profile into a test's temporary directory) and then not
built, because the operator preferred to configure a clean installation. There is therefore no
half-migrated state anywhere in the code to reason about later.

**The literal in cleanUserAgent was the sharp edge.** Electron builds the User-Agent out of
the application's name, and the function that took it back out matched `/msg-hub\//`. After a
rename that pattern matches nothing, and the failure is silent: the new name simply starts
going out to Meta's servers. The end-to-end test guarding it – `not.toMatch(/msg-hub/i)` –
would have stayed green, because it named the old string too. Both now ask the running
application what it is called. Proved by mutation on 2026-08-26: with the literal restored,
the test failed with `m-hub/0.4.0 chrome/150...` in the received User-Agent.

**The installer stopped wearing NSIS's blue wizard.** electron-builder passes
`build/installerSidebar.bmp` to `MUI_WELCOMEFINISHPAGE_BITMAP` and falls back to
`nsis3-metro.bmp` when it is missing, which is what the finish page showed until now. The two
bitmaps – 164x314 beside the welcome and finish pages, 150x57 on the header of the rest – are
drawn from the same four rounded rectangles as the icon, by a rasteriser in `build/mark.mjs`,
so the mark has one source. A .bmp stores its rows bottom-up and pads each one to four bytes;
neither mistake fails a build, both produce a garbled wizard, and `tests/bmp.test.js` reads
them back out of the bytes. The header bitmap is white because MUI paints that bar white.

**Settings end with a nameplate.** What a bug report needs – the version, the build date and
commit, the Electron and Chromium underneath, the profile directory and its size, the licence
and the address of the sources – set like the rating plate on a piece of equipment, at the foot
of the settings, on the groove rather than the panel so it reads as a plate and not as one more
setting. Every value is read from the running process or from the manifest electron-builder
packed: CI writes the date (UTC) and the commit it checked out into the package through
`extraMetadata`, a run from the sources has neither and says so, and `package.spec.js` checks on
the package itself that both arrived. The size is every byte under the profile, walked
asynchronously on an IPC channel of its own after the dialog is already open – 843 MB in 3366
files on a real profile, 772 ms when walked synchronously, measured 2026-09-07, which is why it
is neither synchronous nor part of the answer the dialog waits for. The two buttons hand the
system a folder and an address this process chose; the renderer names neither, for the same
reason "Show in folder" is given an id rather than a path.

**A quit that arrives during startup.** `createWindow` awaits the accounts file and then the
renderer, and the close handler that saves the layout is attached only after both. A quit
before that – Playwright's `close()` in a test that starts the application and closes it at
once, on a CI runner slow enough for the read to lose – closed the window the ordinary way and
startup carried on: views added to a window that was gone, `fitViews` throwing "Object has
been destroyed" as an unhandled rejection (measured on CI on 2026-09-07, run 34166392686,
`startup.spec.js`). Startup now stops after each await if the window is gone, `loadFile`
rejecting for that reason is not a load failure, and no tray is built. The regression test
registers `browser-window-created` to quit right after launch, which `launch()` makes
deterministic: it resolves after `app.whenReady()` and before the window exists, three times
out of three. A second one quits on the first `did-start-loading` of the main window, because
Electron rejects an interrupted `loadFile` with ERR_FAILED before the window reports itself
destroyed – so the guards ask the `quitting` flag first, which `before-quit` raises before any
window is closed, and the window second, for a close that did not come through `app.quit()`.
Four such rejections per full local run came from `isolation.spec.js` and
`attachments.spec.js`, which close the application soon after it has a window. The log that found it exists because Playwright's worker teardown waits without
limit for any launched process still alive and names none of them – the end-to-end step runs
with `DEBUG=pw:browser` since the tag build of 0.5.7 failed exactly there, with every test
green.

**The Start with Windows tick.** `setAutoStart` writes the login item with `--hidden`, and the
tray read it back with `app.getLoginItemSettings().openAtLogin`, asking without arguments.
Electron compares the Run entry with the executable and with the arguments it is asked about,
so the application said no to its own entry – measured on 2026-09-15 on Electron 43.4.1,
straight after the write: `openAtLogin` false without the arguments, true with them. After
every restart the tick came up empty over an entry that was there, and a click on it switched
autostart on again. `isAutoStartOn` asks with the same `--hidden`, and asks
`executableWillLaunchAtLogin` as well, because `openAtLogin` still says yes to an entry switched
off in Task Manager or Windows Settings: that switch is a disabled mark under `StartupApproved`
which leaves the Run entry where it is, and only `executableWillLaunchAtLogin` reads it. Both
readings were measured on the application itself: a module loaded with `-r` ahead of it – the
way Playwright loads its own loader – kept every menu it built, so the tray's own menu item
could be clicked from the main process and read again after a restart, with the registry
checked at each step and cleaned afterwards. The tests hold `isAutoStartOn` to a model of that
behaviour rather than to a list of calls: with the old reading two of them fail, and without
the second question the Task Manager one does.

**Reloading an account (0.6.0).** Keys are read in `before-input-event` on every webContents –
the window's and each view's – and turned into commands by `commandFor` in `key-commands.js`, so
F5 means the same wherever the keyboard is. Every way of acting on an account – a key, the
status bar, the channel menu – goes through one `runAccountCommand`, which refuses keys while a
dialog has the views stepped aside. A page with a `beforeunload` handler refuses the reload,
and in a `WebContentsView` Electron turns the refusal into silence; `will-prevent-unload` says
it happened, and `UnloadGuard` tells a refusal of a reload asked for in the last five seconds
from one of the page's own navigations, so the offer to discard appears only for the former.
A restart is `forcefullyCrashRenderer` and a reload, and the crash it causes is marked expected
for five seconds, because `render-process-gone` arrives a task later and would otherwise
announce a crash nobody had. The end-to-end tests send keys with `sendInputEvent`, the path a
real key takes: Playwright's keyboard goes round `before-input-event`, and a test using it
would pass whether the keys worked or not.

**The channel menu (0.6.0).** A native menu, because the account views sit above the page and
would cover anything drawn in it. While it is open, a leave reported by the rail is not acted
on – the pointer moving onto the menu reads as leaving – and once it closes the renderer is
asked where the pointer is, as after the window comes back to the front. A view takes focus
while it loads, and the focus listener routes a focus to the rail as a clicked notification;
the flag that kept a loading view out of that used to be set once, by the first load, so a
background reload could pull the rail over to itself. It is now the `settling` set, which an
account joins for every reload asked for here and leaves when the load stops – or at once, when
the page refuses to be left and no load follows. Each account's own windows are counted, so a
restart can say beforehand that they may go with it.

**Two measurements (0.6.0).** Two coming decisions need numbers nobody had. Whether popups
should open inside the account rests on how many are sign-ins and how many are articles, and
`disposition` cannot tell those apart; `hostClass` in `navigation.js` names the kind of host –
`service`, `auth`, `shim`, `external`, `block` – and `window-open` records that and the
disposition, never the address. `classify` decides from the same class, so the description and
the decision cannot drift apart. Whether sleeping accounts pays rests on what an awake one costs;
`account-memory.js` adds up the private memory of an account's renderer and of the processes
its frames run in, from `app.getAppMetrics()`, and `account-memory` records it in megabytes when
Settings opens and fifteen minutes after the start.

**Stepping through an account (0.6.1).** `commandFor` turns Alt+← and Alt+→ into `back` and
`forward`, and they reach `runAccountCommand` with the reloads, so the dialog rule and the guard
come for free; the guard is armed only when a step actually started, or a press with nowhere to go
would turn the page's next refusal of its own navigation into an offer to discard. The keyboard's
Back key never arrives in `before-input-event` as a key at all – it comes as the window's
`app-command` – while the mouse's side buttons are Chromium's own and take exactly one step,
which a test holds. The status bar learns where an account stands from `nav:state`, sent on
`did-frame-navigate`, `did-navigate-in-page` and `did-fail-load`: Electron reports a committed
error page by the last alone, though it is an entry in the history like any other. Three things
the tests had to learn on CI. `getActiveIndex()` answers with the PENDING entry while a navigation
is on its way, so a test waits for the committed address before the next key. A page's own
`pushState` counts for Back only after a real activation – a gesture injected through
`executeJavaScript` leaves the entry skippable – so the test clicks through CDP. And `loadURL`
over a live page can reject with the abort that page reports of its own load – not only the load
that cut it short, as was thought here, but a later one too; 0.6.2 below.

**Windows a page opens (0.6.1).** In such a window `commandFor` passes only the keys of a small
browser – back, forward, reload, hard reload and the developer tools – and acts on that window, not
on the account behind it. Its menu is built once and only its items are switched on and off, since
a menu replaced while open would be pulled out from under the click. A handled Alt+← does not
uncover the hidden menu bar: after a handled key down Chromium drops every key up until the next
key down, the Alt's included, so the window never sees Alt let go – the end-to-end test holds both
halves, Alt+← leaving the bar hidden and Alt alone showing it. Moving a page into the account view
hides the window, loads the address in the view, and closes the window only once the load has
committed; a refused load, or a window whose own page refuses to close, brings it back.

**Knowing that a page arrived (0.6.2).** The move above was judged by the promise `loadURL`
returns, and that promise answers a narrower question than it seems to. Electron fails it on the
first failure the main frame reports after the load was asked for, whichever page the failure is
about, and the page being left reports its own unfinished load as aborted when the new one cuts it
short – at once, or only after the new page is in (the first build of the v0.6.1 tag met it in a
window, run 39074653622). A page that had reached the account view could so bring its window back
beside it. The promise can also resolve on the page in front rewriting its own address before the
new load has started, which would close a window whose page never came. `loadAndLand` in
`landing.js` starts the load and answers from what the view reports instead: a commit of the main
frame, or a step within the page to that very address, is an arrival; an error page, or the abort
Electron reports with the address itself when the page in front refuses to be left, is a failure,
and so is loading that stops, or a view that goes away, without a commit; an abort reported of any
other address decides nothing. Its listeners are in place before the load starts, since the first
reports can come before `loadURL` returns. The end-to-end tests load their pages the same way,
through `loadInto`, and the test of the move was seen failing on CI before the fix went in (run
39114324854).

**Putting an account to sleep (0.7.0).** Sleep is `ViewManager.sleep`, and its order is the
reverse of `remove()`: the view is closed first and detached only on `destroyed`. The close is
`close({ waitForBeforeUnload: true })`, so a page holding a draft can refuse it, and a view already
detached and stripped of its listeners would then be a renderer nobody answered for. Until
`destroyed` the account is falling asleep: `show()` and `add()` treat it as unavailable, the crash,
hang and focus handlers say nothing for it, and a refusal arrives as `will-prevent-unload`, which
keeps the account awake and offers "Sleep anyway" through the same `UnloadGuard` as a refused
reload. A repeat that starts nothing – the account has come to the front meanwhile – takes the
guard's permission back at once, since no refusal will come to spend it. Sleep is refused for the
account in front, for one playing sound (`isCurrentlyAudible()`) and for one with a window of its
own open, which the close would take with it. What the close reports was measured before the
feature had a line, in a bare Electron 43.4.1 that `view-close.spec.js` starts on its own, because
Playwright's CDP takes a real `beforeunload` for a dialog of its own (run 39164517156). A plain
close, a hidden one and a close during a load report `destroyed` and nothing else within 1–8 ms, so
no crash, hang or failed load is announced. A page with an unconditional `beforeunload` refuses even
without an earlier click, because the close itself counts as a user activation. And a service
worker keeps the old process alive for about 30 s, while a view woken meanwhile gets a process of
its own and loads from the worker's cache in tens of milliseconds.

**Waking an account (0.7.0).** Waking is `add()` on the same partition at `wakeIndex` – the number
of awake accounts before it in the rail's order, since the window's children are the awake views
alone – and the `prepareView` every view goes through. A session outlives every view it had, so
what is registered on the session is registered once (`wiredSessions`) and what belongs to the
view is registered on each new one; an end-to-end test counts both after three sleeps. A click on a
sleeping channel and Ctrl+1..9 come through `accounts:switch`, which wakes first, and waking takes
long enough for a second choice: `switchAccountHandler` counts the switches and only the latest
shows its account, and the renderer leaves the rail alone when an answer comes for a choice that is
no longer the latest. A wake that finishes after quitting began makes no view, as `add()` returns
nothing for a window that is gone. The reminder is `SleepReminder`: after a resume it always
speaks; when the window is shown, only once the oldest sleep is half an hour old and the last
reminder an hour gone. The log records `account-slept`, `account-woke` with the milliseconds to the
first `did-stop-loading`, `account-sleep-refused` with its reason, the account's private memory
before the close, and the whole application's before and once the account's processes are gone –
or `timeout` after 90 s. The account's own memory after the close cannot be read, its processes
being gone; what shrinks is the whole. One lesson came from the tests, not the feature: a load
gives its view the focus, and a focused view in the background is routed as a clicked
notification, so a test that blanks every view hands the rail to the last one blanked (run
39166887625) – the same focus that made the taskbar flash, 0.7.1 below.

**Focus nobody asked for (0.7.1).** The taskbar button flashed orange with nothing new, twice
over. Electron 43 focuses a webContents on every navigation of its main frame while its window
counts as active – `ReadyToCommitNavigation` calls `SetInitialFocus` unless `focusOnNavigation` is
off – and the account views took that default, the ones behind the account in front included. A
page loading again by itself took the keyboard, the focus listener took that for a clicked
notification and switched to it, and with the window in the background the switch's
`webContents.focus()`, which on Windows activates the window, asked for the foreground; Windows
answers that by flashing the button, and the operator came back to another account in front.
`createView` turns the focusing off. The account in front gets the keyboard from `show()`, which
every choice of the operator goes through, and the `settling` set stays as a second guard; the test,
a page's own `location.reload()` behind the account in front, was seen failing on CI before the fix
(run 39178627361). The second flash came at login. The login item starts the application with
`--hidden`, and a window remembered maximized was maximized right after it was built – and Electron
shows a hidden window it is asked to maximize (`NativeWindowViews::Maximize`), without the
foreground, so the focus given to the account in front asked for it again. `windowRevealer` in
`shell.js` holds the maximize back until the window is first asked for – from the tray, its menu, a
second launch or the macro shortcut – and keeps the layout saying maximized until then, for a window
quit from the tray unseen (run 39233805493 before the fix).

## 10. Tests

Behaviour is tested, not implementation detail.

- **session isolation** – proof that a cookie written in one account's partition is invisible
  in another's. The heart of the product, so covered by a test rather than by inspection.
- `accounts` – read, write, damaged file, missing file, refusal to change `id`
- `macros` – adding, searching, deleting along with attachment copies, the size limit
- `insertion` – content reaches the clipboard in the expected shape; **a negative test: no
  path invokes sending a message** (enforcement of rule 7.1)
- `shell` – the window layout survives a restart

## 11. Risks

| Risk | Weight | Response |
|---|---|---|
| WhatsApp refuses the client over `User-Agent` | high | override the UA from the first launch; stage 1 |
| Electron's Chromium too old for WhatsApp | medium | keep the version fresh; the fix is a version bump |
| Delay inserting a file (`powershell.exe` startup) | low | measured in stage 3; noticeable above ~500 ms, beyond that a native module |
| The attachment store growing without bound | low | per-file limit, a usage counter, copies deleted with the macro |

The risk "the clipboard does not accept files" was **closed** in stage 0 (2026-08-23). With
it went the risk of being sensitive to Meta rebuilding the page – the mechanism of
substituting a file into a form does not enter the design.

## 12. Rejected alternatives

Recorded for the record. The road to this design was long, and these dead ends are documented
so that nobody walks back into them.

**A web version as a page with tabs.** Not feasible. `web.whatsapp.com` sends
`frame-ancestors https://*.whatsapp.com https://whatsapp.com`, and `www.messenger.com` sends
`frame-ancestors 'self'`. Embedding either in a frame on a foreign domain is blocked by the
browser. Working around it with a rewriting proxy was rejected: WhatsApp Web rests on
WebSockets, service workers and Web Crypto, and that kind of manipulation would be
indistinguishable from an attack.

**A hub on a server, streamed with Neko (WebRTC).** Rejected after looking at the topology:
WebRTC media travels over UDP, while the operator's ingress is a Cloudflare Tunnel on a CGNAT
link. It would require a TURN server or open UDP ports – the first adds a dependency billed
by traffic, the second is impossible.

**A hub on a server, streamed with KasmVNC.** Technically feasible (WebSockets pass through
the tunnel) and designed all the way to the deployment stage, then withdrawn on 2026-08-23
along with the decision to drop access from the work laptop. It would have cost WSL2 and
Docker Engine on a node – the first container in that infrastructure and a permanent widening
of the maintenance surface.

**Cloudflare browser-based RDP.** A workable fallback should remote access ever return as a
requirement: available on all plans, reuses the existing `cloudflared` and CF Access, and
leaves the RDP port on loopback. Dropped for the same reason as above.

**C# WPF with WebView2, and Tauri 2.** A lighter result (roughly 15 MB and 10 MB against
roughly 200 MB), but the first needs the .NET SDK installed and pulls in a stack outside the
operator's toolkit, while the second needs a Rust toolchain and rests on a young API across
several webviews.
