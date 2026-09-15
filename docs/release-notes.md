# Release notes

## 0.5.9 – the Start with Windows tick survives a restart

**The tick beside Start with Windows in the tray menu came back empty after every restart, with
autostart still on.** Autostart is written with `--hidden` on the command line, so that a start
at login goes straight to the tray, and the tray asked for it back without that argument.
Electron compares the entry with the executable and with the arguments it is asked about, so
the application did not recognise its own entry: measured on 2026-09-15 on Electron 43.4.1,
straight after the write, the answer was no without the argument and yes with it. Autostart
itself kept working – only the tick misreported it, and a click on the empty tick switched
autostart on again instead of off. The tick now asks with the same argument.

**Autostart switched off in Task Manager or in Windows Settings no longer shows as on.**
Switching it off there leaves the entry in place and only marks it disabled, and a question
about the entry alone still answered yes for a start Windows was going to skip. The tick now
also asks whether the application will actually be launched at login, so it comes up empty in
that case, and one click on it switches autostart back on for real.

**How it was found.** Reading how autostart is written showed that it was read back
differently. It was confirmed on the application itself before anything changed – tick it,
quit, start again, and an empty tick over an entry that was there – and the same sequence was
run against the fix, with the Task Manager mark set by hand. The new tests hold the tick to a
model of that measured behaviour; put the old reading back and two of them fail.

## 0.5.8 – a quit during startup is a quit

**Quitting the application while it was still starting left it running on a window that was
already gone.** The close handler that saves the layout is attached at the end of startup, so a
quit that arrived before then closed the window the ordinary way, and startup carried on
regardless: the account views were added to a window that no longer existed, and working out
their size threw "Object has been destroyed" into an unhandled rejection. Measured on CI on
2026-09-07, where the test that starts the application and closes it at once reached the main
process while the accounts file was still being read; on the author's machine the read wins
that race every time. An exception in the main process is also how an exit has been blocked
before, so this is not left to luck: startup now stops at the first sign that the window is
gone, the renderer is not loaded into it, no tray icon is built for it, and a regression test
asks for the quit the moment the window is created, which is the earliest anybody can.

**The same quit a moment later, while the renderer is loading, was a second exception.**
Electron reports the interrupted load as a failure, and it does so before the window reports
itself gone, so asking the window was not enough: the flag raised the moment a quit is asked
for is what tells the two apart. A full run of the test suite carried four of these per run
before this release, from tests that close the application soon after it has a window, and
none after it. A second regression test asks for the quit as the renderer starts loading.

**How it was found.** The tag build of 0.5.7 passed all of its tests and then failed on the
teardown of the test worker, which waits without limit for any process still alive and does
not say which. The end-to-end step now logs every process it starts, with the test it belongs
to, its errors and its exit, and the first such log carried the rejection above. Whether that
same race was what kept a process alive on the failed run is not proven; that it could is.

## 0.5.7 – a nameplate in Settings

**Settings now end with a nameplate.** The foot of the dialog carries what a bug report needs
and nobody could get at without opening a file: the version; the build, as its date and the
commit it was made from; the Electron and Chromium underneath; the profile directory, how much
it holds on disk, and a button that opens it; and the licence with the address of the source
code. Every value is read from the running process or from the manifest the installer packed,
so none of it can go stale, and the plate can be selected and copied into a message.

**A build knows when it was built.** CI writes the date (UTC) and the commit into the package
as it builds it, and the packaged application shows them. A copy run from the sources has
neither and says "running from source", rather than showing the day the files were last
touched. The test that runs on the package itself now checks that both arrived.

**The engine is on the plate because the error message talks about it.** When WhatsApp Web
refuses an old Chromium, the failure message has always said to update Electron. The version
it means is now one look away.

**The size of the profile is measured, not estimated.** It is every byte under the profile –
sessions, Chromium's caches, the log, the attachments – walked when the dialog opens. On the
author's own profile that is 843 MB in 3366 files and takes most of a second, so the dialog
opens on the facts and the number lands a moment later, shown the way Explorer shows sizes so
the two can be compared.

## 0.5.6 – a correction about Smart App Control, and where the signature is going

**Turning Smart App Control off is no longer a one-way door, and these notes said it was.** Until
a Windows update in April 2026 it was one: switching the protection back on meant reinstalling
Windows, and the installation notes said so in both languages, in every release. Microsoft has
since made it a toggle in Windows Security. The advice that mattered has not changed – do not
switch off a protection covering every program on the machine because one program is unsigned,
run M-HUB from source instead – but the reason given for it had gone stale.

**Where the signature is going.** M-HUB is applying to the SignPath Foundation, which gives open
source projects free code signing. The installation notes and both READMEs now say so. Until it is
granted, releases stay unsigned and Windows goes on treating them as unknown.

Nothing about the application itself changed.

## 0.5.5 – the log says how many accounts it found

**The first line of the log now carries a number that means something.** It always read
`started count=0`, whatever the profile held. The line was written the moment the log file
existed, which is before the accounts have been read, and the zero was a placeholder nothing
ever replaced. It now reports how many accounts actually loaded.

That is the first thing to look at when accounts appear to have vanished, and it is a question
this application has already had to answer: the 0.5.0 rename moved the profile directory and
left every account behind. A log reading `count=3` and then `count=0` would have said so at
once, instead of needing an afternoon to work out.

A start that never gets as far as reading the profile now leaves no `started` line at all,
which is what failing to start ought to look like. Nothing else changed.

## 0.5.4 – one dash, and quotations that close

**Nothing about how the application behaves has changed.** No new setting, no fixed crash,
nothing moved. This release exists to make the words look right. If 0.5.3 is running and
reading well, there is nothing here worth the download.

**One dash, everywhere.** The em dash is gone: 505 of them, across the interface, the
documentation and the comments in the code, are en dashes now. In the application itself this
shows in a handful of places – the hint under an empty rail, the tray title carrying an unread
count, the message that reports an account failing to load.

**Polish quotations close with the right mark.** Seven of the eight quotations in the Polish
interface opened with `„` and closed with a straight `"`, which is not a pair. They close with
`”` now, and so do the two in the Polish README and the two in the installation notes, where
the same slip had reached. The English strings keep their straight quotes: there the character
is used consistently, so it was a choice rather than a slip.

**And a build that went red for no reason.** The end-to-end test covering the download setting
read the layout file before the application had written it. A poll whose callback throws is not
a poll: measured 2026-09-02, it gave up in 8 ms on the missing file instead of waiting for it.
Nothing about the application was wrong – the test was – but it failed builds at random, which
is worse than a test that never runs. A file that is not there now means "not yet".

## 0.5.3 – installing over an older copy is an update, and looks like one

**The installer stops asking questions.** It no longer offers a directory, and no longer asks
whether to install for you or for everybody: it installs under your own account, in
`%LOCALAPPDATA%\Programs\M-HUB`, and never raises a password prompt. One click, and it is done.

**Run it where M-HUB already lives and it updates that copy.** That was true before – NSIS
uninstalls the previous version and takes its place, leaving one entry in Settings and one
folder under Programs – but the wizard asked for an install mode and a directory on the way, so
an upgrade was indistinguishable from a first installation. With nothing to ask, there is
nothing to mistake. Your profile is untouched either way: accounts, macros, attachments and
signed-in sessions carry over.

The one thing lost is the choice of folder. It bought little – the per-user location is the
only one an installer can use without an administrator, which is how this application reaches
locked-down machines – and it cost a page that made every upgrade look like starting over.

## 0.5.2 – the window opens where you are looking

**The window no longer remembers where it was; it works out where it belongs.** A remembered
position is only true for the monitor arrangement it was written on, and arrangements change:
two external screens at the desk, the laptop's own screen on the train. Measured on
2026-09-01, a stored layout carrying `x=-1394 y=972` opened the window on no screen at all,
and a later start put it in the corner of a second monitor nobody was looking at. The
application was running and unreachable, which for a window amounts to not running.

M-HUB now opens centred on whichever monitor Windows currently treats as primary. The size it
opens at is trimmed to that monitor's work area first, because a window remembered from a
large external screen is wider than a laptop's, and centring something bigger than the screen
puts its title bar – and its close button – above the top edge.

The size and the maximised state are still remembered: a window closed maximised comes back
maximised, on whichever monitor is primary now. Only the position is gone from the layout
file, because a stored position is a fact nothing reads and everything outlives.

## 0.5.1 – the profile 0.5.0 left behind, and a Microsoft sign-in that arrives whole

**0.5.0 walked away from your setup. This version goes back for it.** Electron builds the
profile directory out of the application's name, so the rename moved it from `%APPDATA%\msg-hub`
to `%APPDATA%\M-HUB` and nothing carried the old one across: accounts, macros, attachments and
signed-in sessions all stayed on disk, in a directory the application had stopped reading. They
are moved on the first start of 0.5.1 – sessions included, so no account asks for a fresh QR
code.

It moves only what the new profile does not already have, and only when that profile has never
held accounts. So it cannot run twice, and it cannot bring back accounts anybody deleted on
purpose: removing every account writes an empty list rather than deleting the file. The accounts
file moves last, which is what lets an interrupted move finish by itself on the next start
instead of stranding the sessions.

**"Sign in with Microsoft" on LinkedIn stopped leaving the application.** It failed in the system
browser with `AADSTS900561: The endpoint only accepts POST requests. Received a GET request.`
The sign-in host list knew `login.microsoftonline.com`, which is where WORK accounts sign in; a
personal Microsoft account goes to `login.live.com`, and the passkey step after it to
`login.microsoft.com`. Neither was declared, so both were handed to the system browser – and
that is why the error was about a method rather than a window: opening an address externally can
only ever be a GET, while the sign-in asks for `response_mode=form_post`. An undeclared sign-in
host does not merely open in the wrong place, it arrives without its method and cannot work
anywhere. Both endpoints are now declared; the work-account one stays, because which is used
depends on the account.

## 0.5.0 – the name, and a wizard that looks like the application

The application is called **M-HUB**. Everything an operator sees carries the new name: the
window, the tray, the taskbar button, the installer and the shortcuts it writes.

**It does not carry a 0.4.0 setup over.** Electron derives the profile directory from the
application's name, so it moves from `%APPDATA%\msg-hub` to `%APPDATA%\M-HUB`, and nothing
migrates it. 0.5.0 starts with an empty profile: accounts, macros, attachments and signed-in
sessions are set up again. The old directory is neither read nor deleted – the installer
leaves it exactly where it is, for you to keep or remove.

**The installer stops wearing NSIS's stock blue wizard.** Its welcome and finish pages – and
the uninstaller's – now show the application's own mark, and so does the header of every page
between them. The graphics are drawn from the same four shapes as the icon, so there is one
source for the mark and no copy to fall out of step.

**The application no longer says its own name to Meta's servers.** Electron builds the default
User-Agent out of the application's name and version, and the code removing it matched a
literal `msg-hub/`. Renaming the application would have left `M-HUB/0.5.0` going out with
every request the account views make, silently, with the test that guards this still green.
Both the code and the test now ask the running application what it is called.

**Upgrading is an upgrade, not a second installation.** The identifier Windows records the
installation under is unchanged, so the 0.5.0 installer finds 0.4.0, removes it, and takes its
place: one entry in Settings, one folder under Programs. The file name is new, though, and a
Smart App Control verdict is per file – see the fingerprint below and `docs/installing.md`.

## 0.4.0 – the mark, a badge that stays put, and downloads that finish

Four things found in the first day of using 0.3.0.

**The taskbar shows msg-hub.** The application has a new mark – three isolated account modules
in one tile, the active one amber – and it now carries nine frames, from 16 to 256 pixels,
instead of one 256 that Windows had to scale down everywhere it actually draws an icon.

If you run from source, `npm run shortcut` writes a Start menu shortcut carrying that icon and
the application's identity; pin **msg-hub** from there and unpin any older "Electron" button.
Windows takes a pinned button's icon from the shortcut, never from the running window, so
pinning a source run without this pins `electron.exe` – Electron's own logo included. An
installed build needs none of it.

**The unread badge stops blinking.** A page with something waiting alternates its own title –
"(1) Messenger", then "Messenger", about once a second – and the badge was following it, on for
a second and off for the next. A count going up is still shown at once; a count dropping to zero
is now believed only after three seconds of zeros. Reading your last conversation clears the
badge a moment later; a blinking page never clears it at all.

**A download says how it ended.** The banner used to say "Downloading…" for the rest of the
session, with the file already on the disk. It now becomes "Saved …", with a button that opens
the folder the file landed in, and it takes itself away after a few seconds. A download that
failed or was cancelled says so and stays.

**Settings gained a download folder** and a "ask where to save every file" switch, which starts
on – that is what the application already did, it just had no way to say so or to stop. Turn it
off and files go straight to the folder you named, numbered rather than overwritten when a name
repeats.

Nothing in this version changes `accounts.json`, `macros.json` or the attachment store, and
nothing about it is one-way.

## 0.3.0 – staying alive, macros 2.0, whole services

**Accounts stay awake.** Chromium treats a view of zero height as a hidden tab and slows its
timers by an order of magnitude – measured here as 10 ticks of a 100 ms timer in ten seconds
against 101 while active. Every account but the current one is exactly that view, and once the
window goes to the tray so is the current one, which is the state this application exists to be
useful in. Background throttling is off.

**One copy, and a window that hides instead of dying.** A second launch reaches the window that
is already open rather than starting a rival over the same profile. The window button puts
msg-hub in the tray; Quit lives on the tray menu, and Settings has a switch for anyone who wants
the button to mean what it usually means. Autostart really starts hidden – Electron's
`openAsHidden` is documented as macOS-only, so the login item passes a flag instead.

**Keys.** `Ctrl+1..9` reaches a channel, `Ctrl+R` reloads the current account, `Ctrl+;` opens the
macro palette, and `Ctrl+Shift+Space` does it from anywhere. A global shortcut is a system-wide
exclusive: when another program already owns it, the status bar says so rather than the shortcut
quietly doing nothing.

**Clicking a notification lands on the account it came from** – the rail follows, instead of
leaving you in a conversation with the wrong channel highlighted.

**Links have a declared place to open.** Until now a link in a conversation opened a bare Electron
window: no address bar, no back, no reload, and inside the account's signed-in session. Every
address is now classified before it goes anywhere, and Meta's link shims – which make an outgoing
link look like a facebook.com address – are consulted before the host list.

**Recovery.** A stale or dead account can be reloaded without restarting the others. A crash, an
unresponsive view, or a laptop waking from sleep offers a reload on the status bar rather than
performing one: reloading throws away whatever is half-typed in a composer.

**A local log** the operator can read and safely send on: it records events and codes from a fixed
list of fields, never message content, and rotates to one older file.

**Macros 2.0.** Tags are in the interface, not only in the file format. A macro may carry
`{placeholders}`, and the application asks for them before the text goes anywhere – cancelling the
question leaves the clipboard exactly as it was. `{date}` and `{data}` fill themselves from the
clock. After an insertion the keyboard goes back into the account instead of staying with the
palette.

**LinkedIn and Facebook can be added as whole services.** LinkedIn is entered at `/feed/` on the
www host – the apex answers "Checking your browser - reCAPTCHA", measured twice. Notifications are
now controlled per account: messengers may interrupt out of the box, whole services stay quiet
until asked, and the account overrides its platform in either direction.

**Neither whole service shows an unread count.** `unreadFromTitle` reads "(99+)" correctly now – it
used to return zero, so the badge vanished exactly when an account was busiest – but LinkedIn's
number is the sum of eight badge sources, and Facebook's 2026 title format could not be confirmed
at all. A badge nobody has seen work would be a promise. Both are one word from being turned on,
and the reason sits on the entry in `src/main/accounts.js`.

### Going back a version deletes LinkedIn and Facebook accounts

A build older than 0.3.0 does not know those platforms. It drops such accounts out of
`accounts.json` while reading it, and writes the shortened list back on the next save – along with
their sign-ins, because a session partition is named after the account id. **This door only opens
one way.** Nothing else in this release is a one-way change.

### Installing

See `docs/installing.md`, attached below: this installer is not code-signed, and on a machine with
Smart App Control enabled it will be blocked no matter what you click. Running from source works
there and is the supported path.
