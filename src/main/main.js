import { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, globalShortcut, screen, shell, powerMonitor, dialog } from 'electron'
import path from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { cleanUserAgent, ViewManager, wakeIndex } from './views.js'
import { loadLayout, saveLayout, centreOn, setAutoStart, isAutoStartOn, acceptHoverReport, HIDDEN_FLAG } from './shell.js'
import { loadAccounts, PLATFORMS, notificationsAllowed } from './accounts.js'
import { classify, hostClass } from './navigation.js'
import { accountMemoryMb, appMemoryMb, processIdsOf } from './account-memory.js'
import { SleepReminder, planSleepOthers, describeSleepOthers } from './sleep.js'
import { commandFor } from './key-commands.js'
import { UnloadGuard } from './unload-guard.js'
import { channelMenuTemplate } from './channel-menu.js'
import { childWindowMenuTemplate, runInWindow } from './child-windows.js'
import { historyState } from './history.js'
import { loadAndLand } from './landing.js'
import { registerAccountChannels, registerMacroChannels } from './bridge.js'
import { createClipboardSession } from './file-clipboard.js'
import { createLogger } from './log.js'
import { migrateProfile, LEGACY_PROFILE_DIR } from './profile.js'
import { resolveDownloadDir, planSave } from './downloads.js'
import { describeBuild, directorySize } from './about.js'
import { WINDOW_ICON, TRAY_ICON } from './assets.js'
import { t, validLanguage } from '../shared/i18n.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))

// Console geometry. The channel rail stands on the left, the status bar along the
// bottom, and the account view sits INSIDE the frame the renderer draws – the margin
// leaves room for the edge painted in the active account's colour.
//
// An unpinned rail collapses to bare channel colours and expands when the cursor
// enters it. Expanding PUSHES the account view aside instead of covering it: account
// views are a native layer ABOVE the renderer, so an overlay drawn in HTML would hide
// underneath the messenger page. A true overlay would need its own native view.
const RAIL_COLLAPSED = 48
const RAIL_EXPANDED = 162
const STATUS_BAR_HEIGHT = 30
const WELL_MARGIN = 10
const MACRO_SHORTCUT = 'Control+Shift+Space'
// How long a finished download stays on the status bar. Long enough to read it and reach the
// button beside it; short enough that a success does not have to be dismissed by hand, which
// is the complaint this whole path exists to answer. A FAILED download does not disappear –
// that one the operator has to notice.
const DOWNLOAD_MESSAGE_MS = 8000
// When the memory of each account is first written to the log – see logAccountMemory.
const ACCOUNT_MEMORY_AFTER_MS = 15 * 60 * 1000
// How long the processes of an account put to sleep are watched for going away. A service worker
// keeps a closed page's process for about half a minute (measured while researching sleep); a
// process still there after this is written down as such rather than waited for.
const SLEEP_MEMORY_WAIT_MS = 90 * 1000
// How long "N accounts put to sleep" stays on the status bar when nothing needs the operator.
const SLEPT_MESSAGE_MS = 8000
// The keyboard's own Back and Forward keys, as Windows reports them to a window. This is the one
// place they are answered – see key-commands.js for why not in before-input-event as well.
const APP_COMMANDS = { 'browser-backward': 'back', 'browser-forward': 'forward' }

// app.getName() rather than a literal: this is the ONE place that knows what the application
// is called, and Electron puts that name straight into the default User-Agent.
app.userAgentFallback = cleanUserAgent(app.userAgentFallback, app.getName())

// Windows attributes a toast to an application by this identifier, and until now it lived
// only in the electron-builder configuration – that is, in the installer, not in the running
// process. Electron exposes a setter and no getter, so this one is verified by reading it
// rather than by a test.
//
// It keeps the old spelling on purpose. NSIS derives the GUID under which Windows records the
// installation from this string, so changing it would make the 0.5.0 installer look like a
// different application: a second entry in Settings, a second folder in Programs, and the
// previous version left behind for someone to uninstall by hand. Nobody sees an appId; the
// name is everywhere else.
app.setAppUserModelId('pl.kencki.msghub')

// Electron's default menu (File/Edit/View/Window) does not belong to this app and on
// Windows it eats a strip inside the client area.
Menu.setApplicationMenu(null)

let window
let tray
let manager
let clipboardSession
let logger
let logDir
// Closing the window hides it; only a deliberate Quit ends the process. Without this flag
// the close handler could not tell the two apart and Quit would hide the window forever.
let quitting = false
// Armed only while an account's zero is being held – see refreshBadge.
let badgeTimer = null

// Interface language. The main process owns the stored value, while the list of
// languages lives in src/shared/i18n.js. The tray menu and load errors are main-process
// surfaces, so they need translating here too.
let language = 'en'
const tr = (key, params) => t(language, key, params)

async function createWindow() {
  const dataDir = app.getPath('userData')
  logDir = path.join(dataDir, 'logs')
  logger = createLogger(logDir)

  // BEFORE the layout is read, because the layout is one of the things that may still be
  // sitting in the old profile. Version 0.5.0 gave the application a productName and Electron
  // builds this directory out of the name, so everything an earlier version wrote lives one
  // directory away, whole and unread. Moving it is a one-off; profile.js decides whether
  // there is anything to move and refuses to touch a profile that has been used.
  //
  // A failure here must not stop the application starting: it comes up on the new profile,
  // as it does today, and says so in the log rather than silently.
  const migration = await migrateProfile({
    from: path.join(path.dirname(dataDir), LEGACY_PROFILE_DIR),
    to: dataDir,
  }).catch((error) => {
    logger.write('profile-migration-failed', { reason: error?.code ?? error?.message ?? String(error) })
    return { moved: [] }
  })
  // count rather than the names: LOGGED_FIELDS is an allowlist, and a field outside it is
  // dropped without a word. The names are visible in the profile directory anyway.
  if (migration.moved.length) logger.write('profile-migrated', { count: migration.moved.length })

  const layoutFile = path.join(dataDir, 'layout.json')
  // Schema version 1 kept this file under a Polish name. Reading the old one when the
  // new one is absent keeps the window position, the pinned rail and the chosen
  // language across the upgrade; the next save writes the new name.
  const legacyLayoutFile = path.join(dataDir, 'uklad.json')
  const layout = await loadLayout(existsSync(layoutFile) ? layoutFile : legacyLayoutFile)
  language = validLanguage(layout.language)

  // The login item passes --hidden. The window is therefore built unshown rather than shown
  // and hidden a moment later, which would flash across the screen at every login.
  const startHidden = process.argv.includes(HIDDEN_FLAG)

  // The primary monitor is whichever one the operator has told Windows is theirs, and it
  // changes with the desk: two external screens some days, the laptop's own on others. A
  // position remembered from one arrangement is wrong in the next, so it is not remembered –
  // it is worked out here, at every start. screen is safe to ask now: createWindow runs after
  // app.whenReady().
  const bounds = centreOn(screen.getPrimaryDisplay().workArea, layout)

  window = new BrowserWindow({
    show: !startHidden,
    ...bounds,
    minWidth: 800,
    minHeight: 600,
    title: 'M-HUB',
    icon: WINDOW_ICON,
    backgroundColor: '#111b21',
    webPreferences: { preload: path.join(HERE, '..', 'preload', 'preload.cjs') },
  })
  window.setTitle('M-HUB')
  if (layout.maximized) window.maximize()

  // An account view is a native layer ABOVE the renderer: while it holds focus – which
  // is most of the working time – the keyboard never reaches the main window and the
  // renderer's shortcuts are dead. The interceptor is therefore attached to EVERY
  // webContents, not just the window. With no menu there is also no "Toggle Developer
  // Tools" item, so F12 is the only way into the messenger page's console. Which key means
  // what is decided in key-commands.js, where it can be tested; this only carries it out.
  const attachShortcuts = (webContents) => {
    webContents.on('before-input-event', (event, input) => {
      const command = commandFor(input, { inMainWindow: webContents === window.webContents })
      if (!command) return

      if (command === 'devtools') {
        const target = manager?.active()?.webContents ?? window.webContents
        target.toggleDevTools()
        return
      }

      // Only ever the key that landed in an account view – in the main window the renderer's
      // own listener has it. The panel is drawn by the main window's renderer, and focus has
      // to return there too, or the operator opens the panel and cannot type in it.
      if (command === 'macros') {
        window.webContents.focus()
        window.webContents.send('macros:open')
        return
      }

      // Everything else is taken out of the page's reach. Services grab Ctrl+digit for
      // themselves – Discord does – and a reload key reaching the app's own window would tear
      // down the interface, the rail and the status bar along with it, so it never means what
      // it usually means there: it always reloads the account being looked at.
      event.preventDefault()

      // Reaching an account without the mouse. The rail's channels are real buttons, but in
      // normal use the keyboard is inside an account page, where Tab never gets to them. The
      // renderer is asked to switch rather than the manager being told directly: it already
      // owns switching, and going round it would leave the rail highlighting the account the
      // operator just left.
      if (command.select !== undefined) {
        window.webContents.send('accounts:select', command.select)
        return
      }

      runAccountCommand(command, manager.activeId, { fromKeyboard: true })
    })
  }

  attachShortcuts(window.webContents)

  // Messages go to the status bar inside the window, not to a modal system dialog.
  // A modal freezes the whole application and demands a click, and one account failing
  // to load should not block the others.
  // A message may carry an OFFER: something the operator can act on from the status bar. It
  // is an offer and not an action because the only thing on offer here – reloading – throws
  // away whatever is half-typed in a composer.
  // A message also carries a TONE, an IDENTITY and, sometimes, a request to disappear on its
  // own. The identity is what makes the last of those safe: a message that asked to be hidden
  // in eight seconds must not take down whatever more important thing arrived in the meantime.
  // Passing an id in replaces a message already on the bar rather than queueing behind it,
  // which is how a download's "saved" takes over from its own "downloading".
  let messageCounter = 0
  const showMessage = (text, { tone = 'error', offer = null, autoHideMs = 0, id = null } = {}) => {
    if (window.webContents.isDestroyed()) return null
    const messageId = id ?? `msg-${(messageCounter += 1)}`
    window.webContents.send('message:show', { text, tone, offer, autoHideMs, id: messageId })
    return messageId
  }

  manager = new ViewManager(
    window,
    app.userAgentFallback,
    ({ account, code, description }) => {
      // A view on its way to sleep was closed on purpose; whatever it reports now is not news.
      if (manager.isFallingAsleep(account.id) || manager.isAsleep(account.id)) return
      // The description comes from Chromium and names a failure, not a page – ERR_NAME_NOT_
      // RESOLVED and its kin. It is the one string here worth keeping.
      logger.write('account-load-failed', { account: account.id, platform: account.platform, code, reason: description })
      showMessage(tr('loadAccountFailed', { account: account.name, code, description }), {
        offer: { action: 'reload', accountId: account.id },
      })
    },
    {
      // Closing an account's view takes the windows its page opened down with it, so an account with
      // one open is not put to sleep. Asked at the moment of asking, never remembered.
      hasChildWindows: (accountId) => Boolean(childWindows.get(accountId)?.size),
      onSlept: (accountId) => fellAsleep(accountId),
    },
  )

  // A page with an unsent draft can refuse to be left, and Electron turns the refusal into
  // silence – see unload-guard.js. The guard is told what is about to happen, so a refusal can
  // be traced back to it and the operator offered to go ahead with exactly that.
  const guard = new UnloadGuard()

  // Accounts whose page is loading because of something asked for HERE – the view being
  // created, a reload – rather than something the page did. A view takes the system's focus
  // while it loads, and that is not a clicked notification: the focus listener in prepareView
  // routes nothing for an account in this set. It used to be a flag inside prepareView, set
  // once by the first load, which a reload of an account in the background could not reach.
  const settling = new Set()
  const reloadView = (accountId, mode) => {
    const started = manager.reload(accountId, mode)
    if (started) settling.add(accountId)
    return started
  }

  // What each command does to an account. Every one of them leaves the page, so a page with a
  // draft can refuse any of them, and the guard has to know which one it was.
  const ACCOUNT_COMMANDS = {
    reload: (accountId) => reloadView(accountId, 'normal'),
    'hard-reload': (accountId) => reloadView(accountId, 'hard'),
    restart: (accountId) => reloadView(accountId, 'restart'),
    back: (accountId) => manager.goBack(accountId),
    forward: (accountId) => manager.goForward(accountId),
    home: (accountId) => manager.goHome(accountId),
    // Closing the page asks it first, so a draft can refuse this as it can refuse a reload.
    sleep: (accountId) => sleepAccount(accountId),
  }

  // Every request to act on an account comes through here – a key, the status bar, the
  // channel menu – so the rules below cannot differ between the ways in.
  const runAccountCommand = (command, accountId, { fromKeyboard = false } = {}) => {
    if (!accountId || !Object.hasOwn(ACCOUNT_COMMANDS, command)) return false
    // While a dialog is open the account views step aside, out of sight. A key pressed then is
    // meant for the dialog, and a reload behind it would throw a draft away where nobody can
    // see it go.
    if (fromKeyboard && !manager.visible) return false
    // Armed only for something that actually started. A step back with nowhere to go starts
    // nothing, and armed anyway it would claim the next refusal of the page's own navigation –
    // offering to repeat a Back nobody needed. A refusal is the page's answer, a task later at the
    // earliest, so arming after the start is never too late.
    const started = ACCOUNT_COMMANDS[command](accountId)
    if (started) guard.arm(accountId, command)
    return started
  }

  // Putting accounts to sleep and waking them – the operator's choice to give up an account's
  // notifications for a while, made by hand and nowhere else (docs/design.md, section 3). The view
  // side is ViewManager.sleep; this side writes down what it cost and what came back, and makes a
  // woken account's view the way every other view is made.
  const accountsFile = path.join(dataDir, 'accounts.json')
  const reminder = new SleepReminder()
  // Account id -> what was known as its sleep was asked for: the processes behind its page, which
  // are gone by the time it has fallen asleep, and what it and the whole application cost then.
  const sleepNotes = new Map()

  const sleepAccount = (accountId) => {
    const account = manager.accounts.get(accountId)
    const view = manager.liveView(accountId)
    const metrics = app.getAppMetrics()
    const pids = view ? processIdsOf(view.webContents) : []
    const result = manager.sleep(accountId)
    if (!result.ok) {
      logger.write('account-sleep-refused', { account: accountId, platform: account?.platform, reason: result.reason })
      return false
    }
    sleepNotes.set(accountId, {
      pids,
      at: Date.now(),
      account: accountMemoryMb(metrics, pids),
      app: appMemoryMb(metrics),
    })
    return true
  }

  // The measurement decision 10 of the report on sleep asked for, in the log: what the account cost
  // awake, the whole application before, and the whole application once the account's processes
  // have gone – or after SLEEP_MEMORY_WAIT_MS if they have not, said as such.
  const watchMemoryRelease = (accountId, platform, note) => {
    const check = () => {
      if (window.isDestroyed()) return
      const metrics = app.getAppMetrics()
      const ms = Date.now() - note.at
      const gone = accountMemoryMb(metrics, note.pids) === null
      if (!gone && ms < SLEEP_MEMORY_WAIT_MS) {
        setTimeout(check, 1000)
        return
      }
      logger.write('app-memory', { account: accountId, platform, count: appMemoryMb(metrics), reason: gone ? 'after' : 'timeout', ms })
    }
    check()
  }

  const fellAsleep = (accountId) => {
    const account = manager.accounts.get(accountId)
    const note = sleepNotes.get(accountId)
    sleepNotes.delete(accountId)
    settling.delete(accountId)
    reminder.fellAsleep(accountId)
    logger.write('account-slept', { account: accountId, platform: account?.platform })
    if (note) {
      if (note.account !== null) logger.write('account-memory', { account: accountId, platform: account?.platform, count: note.account, reason: 'before' })
      if (note.app !== null) logger.write('app-memory', { account: accountId, platform: account?.platform, count: note.app, reason: 'before' })
      if (note.pids.length) watchMemoryRelease(accountId, account?.platform, note)
    }
    refreshBadge()
  }

  // A new view on the same partition – signed in still, its page starting from its address. Put
  // back among the awake views in the order of the rail, and wired like every other view. Waking in
  // the background leaves the operator where they are; showing it is the caller's business.
  const wakeAccount = async (accountId) => {
    if (manager.isFallingAsleep(accountId)) await manager.settled(accountId)
    if (!manager.isAsleep(accountId)) return false
    const { accounts } = await loadAccounts(accountsFile)
    // Asked again: another wake may have finished while the file was being read.
    if (!manager.isAsleep(accountId)) return false
    const account = accounts.find((candidate) => candidate.id === accountId)
    if (!account) return false
    const index = wakeIndex(accounts.map((candidate) => candidate.id), accountId, (id) => manager.views.has(id))
    const view = manager.add(account, { index })
    if (!view) return false
    const startedAt = Date.now()
    view.webContents.once('did-stop-loading', () =>
      logger.write('account-woke', { account: accountId, platform: account.platform, ms: Date.now() - startedAt }),
    )
    prepareView(view, account)
    reminder.woke(accountId)
    fitViews()
    refreshBadge()
    return true
  }

  const wakeAll = async () => {
    for (const accountId of manager.asleepIds()) await wakeAccount(accountId)
    return true
  }

  // Every account but the one in front, in one click – the operator's own scenario. Each goes
  // through runAccountCommand like a single sleep, so a page that refuses gets its own offer to go
  // ahead. The ones that cannot sleep are named on the status bar, not skipped in silence.
  const sleepOthers = async () => {
    const { accounts } = await loadAccounts(accountsFile)
    const plan = planSleepOthers(accounts.map((account) => account.id), (id) => manager.sleepRefusal(id))
    let slept = 0
    for (const accountId of plan.toSleep) if (runAccountCommand('sleep', accountId)) slept += 1
    const kept = plan.kept.map(({ id, reason }) => {
      const account = manager.accounts.get(id)
      logger.write('account-sleep-refused', { account: id, platform: account?.platform, reason })
      return { name: account?.name ?? id, reason }
    })
    // Gone on its own when everything went as asked; kept on the bar when an account stayed awake,
    // since that one still delivers notifications the operator may have meant to silence.
    showMessage(describeSleepOthers({ slept, kept, tr }), { tone: 'info', autoHideMs: kept.length ? 0 : SLEPT_MESSAGE_MS })
    return slept
  }

  ipcMain.handle('accounts:wake-all', () => wakeAll())

  // Where the account being looked at can go, for the buttons on the status bar. Sent rather than
  // asked for, because it changes with every step the page takes, most of them without a load. The
  // account goes with it, so a word about an account the operator has just left is not taken for
  // one about the account now in front.
  const sendNavState = (accountId) => {
    if (!accountId || window.isDestroyed() || window.webContents.isDestroyed()) return
    window.webContents.send('nav:state', { accountId, ...manager.navState(accountId) })
  }

  // The keyboard's Back key arrives here whichever webContents holds the focus. A key, so it is
  // held back while a dialog is open, as F5 is.
  window.on('app-command', (_event, name) => {
    if (Object.hasOwn(APP_COMMANDS, name)) runAccountCommand(APP_COMMANDS[name], manager.activeId, { fromKeyboard: true })
  })

  let closeToTray = Boolean(layout.closeToTray)
  let downloadDir = String(layout.downloadDir ?? '')
  let askWhereToSave = layout.askWhereToSave !== false
  // Message id -> where the file landed. The renderer asks for a folder by the id of a
  // download this process recorded, never by handing back a path: showItemInFolder with an
  // argument a page could choose would be a way to point Explorer at anything on the disk.
  const downloads = new Map()
  let railPinned = Boolean(layout.railPinned)
  let railHovered = false
  const railExpanded = () => railPinned || railHovered
  // While a channel's menu is open the pointer is over the menu, not the rail, and Chromium
  // reports that as the pointer leaving. Acted on, the rail would fold away under the menu and
  // take the channel that was clicked with it – so leaves wait until the menu closes.
  let channelMenuOpen = false

  const fitViews = () => {
    // resize arrives from the window and account changes from the bridge; neither knows
    // whether the window is still there.
    if (window.isDestroyed()) return
    const { width, height } = window.getContentBounds()
    const rail = railExpanded() ? RAIL_EXPANDED : RAIL_COLLAPSED
    manager.setGeometry({
      x: rail + WELL_MARGIN,
      y: WELL_MARGIN,
      width: Math.max(0, width - rail - WELL_MARGIN * 2),
      height: Math.max(0, height - STATUS_BAR_HEIGHT - WELL_MARGIN * 2),
    })
  }

  const railState = () => ({ pinned: railPinned, expanded: railExpanded() })

  const broadcastRailState = () => {
    if (!window.webContents.isDestroyed()) window.webContents.send('rail:changed', railState())
  }

  // The main process is the single owner of the rail state: it computes the geometry of
  // the views, so the renderer only reports events and receives a finished decision.
  ipcMain.handle('rail:state', () => railState())

  // Not every mouseleave the renderer reports means the pointer left – see
  // acceptHoverReport in shell.js, where the rule and the measurement behind it live.
  ipcMain.handle('rail:hover', (_event, hovered, pointerStillInside) => {
    if (!hovered && channelMenuOpen) return
    if (!acceptHoverReport({ hovered, pointerStillInside, windowFocused: window.isFocused() })) return
    railHovered = Boolean(hovered)
    fitViews()
    broadcastRailState()
  })

  ipcMain.handle('rail:pin', (_event, pinned) => {
    railPinned = Boolean(pinned)
    fitViews()
    broadcastRailState()
  })
  window.on('resize', fitViews)

  // acceptHoverReport holds back a leave reported from inside the rail while the window was
  // in the background – but holding one back loses it, and Chromium sends no second one
  // once it considers the pointer gone. So the moment the window is back in front, ask the
  // renderer where the pointer actually is now instead of living on the stale answer.
  window.on('focus', () => {
    if (!window.webContents.isDestroyed()) window.webContents.send('rail:recheck')
  })

  const currentLayout = () => {
    const rect = window.getNormalBounds()
    return {
      // No x or y. The window is centred on the primary monitor at every start, so a stored
      // position would be a fact nothing reads – and the kind that rots quietly: the value
      // this file carried on 2026-09-01 pointed at a monitor that was no longer there.
      width: rect.width,
      height: rect.height,
      maximized: window.isMaximized(),
      railPinned,
      closeToTray,
      downloadDir,
      askWhereToSave,
      language,
    }
  }

  ipcMain.handle('accounts:reload', (_event, accountId, command = 'reload') =>
    runAccountCommand(command, accountId ?? manager.activeId),
  )

  // The operator chose to leave a draft behind. Only what was refused a moment ago is repeated
  // – the guard hands back nothing else – and the repeat itself is not armed again: it is the
  // one navigation allowed past the page's refusal.
  ipcMain.handle('accounts:proceed', (_event, accountId) => {
    const action = guard.proceed(accountId)
    if (!action) return false
    // A repeat that starts nothing – a sleep refused because the account is now in front – meets no
    // refusal to spend the permission on, and the permission must not outlive the moment.
    const started = ACCOUNT_COMMANDS[action](accountId)
    if (!started) guard.revoke(accountId)
    return started
  })

  // Back, Forward and Start on the status bar. Only those three: this is not a way to reach a
  // restart, which has its own menu item and its own warning.
  const NAVIGATIONS = new Set(['back', 'forward', 'home'])
  ipcMain.handle('accounts:navigate', (_event, accountId, direction) => {
    if (!NAVIGATIONS.has(direction)) return false
    const target = accountId ?? manager.activeId
    const done = runAccountCommand(direction, target)
    // The click took the keyboard into the status bar. Given back, typing and the next Alt+Left go
    // to the page, as they did before the click.
    if (target === manager.activeId) manager.active()?.webContents.focus()
    return done
  })

  // A right click on a channel – see channel-menu.js for what it offers and why. Opened where
  // the pointer is. Once it closes, chosen from or not, the renderer is asked where the pointer
  // is now, as when the window comes back to the front: the leaves held back meanwhile are
  // gone, and Chromium sends no second one.
  ipcMain.handle('accounts:menu', (_event, accountId) => {
    const account = manager.accounts.get(accountId)
    if (!account || window.isDestroyed()) return false
    const template = channelMenuTemplate({
      account,
      hasChildWindows: Boolean(childWindows.get(accountId)?.size),
      asleep: manager.isAsleep(accountId) || manager.isFallingAsleep(accountId),
      sleepRefusal: manager.sleepRefusal(accountId),
      canSleepOthers: [...manager.views.keys()].some((id) => id !== manager.activeId && !manager.isFallingAsleep(id)),
      tr,
    })
    const actions = {
      wake: () => wakeAccount(accountId),
      'sleep-others': () => sleepOthers(),
    }
    const clickFor = (id) => {
      if (Object.hasOwn(ACCOUNT_COMMANDS, id)) return () => runAccountCommand(id, accountId)
      return actions[id]
    }
    const menu = Menu.buildFromTemplate(template.map((item) => (clickFor(item.id) ? { ...item, click: clickFor(item.id) } : item)))
    channelMenuOpen = true
    menu.popup({
      window,
      callback: () => {
        channelMenuOpen = false
        if (!window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send('rail:recheck')
      },
    })
    return true
  })

  ipcMain.handle('closeToTray:get', () => closeToTray)

  // Written straight away like the language, and for the same reason: a rare deliberate
  // choice that must not be lost to a killed process.
  ipcMain.handle('closeToTray:set', async (_event, next) => {
    closeToTray = Boolean(next)
    await saveLayout(layoutFile, currentLayout(), legacyLayoutFile).catch(() => {})
    return closeToTray
  })

  // Downloads. `resolved` is what the operator is shown, so that "the system Downloads folder"
  // appears as a path rather than as a blank field, while the stored value stays empty and
  // travels with the profile.
  const downloadSettings = () => ({
    dir: downloadDir,
    resolved: resolveDownloadDir(downloadDir, app.getPath('downloads')),
    ask: askWhereToSave,
  })

  ipcMain.handle('downloads:settings', () => downloadSettings())

  // Explorer is handed a path this process recorded under that id – see the note on the map.
  ipcMain.handle('downloads:show', (_event, downloadId) => {
    const savedAs = downloads.get(downloadId)
    if (!savedAs) return false
    // Moved, renamed, or emptied out of the bin between the download and the click. Saying so
    // beats opening a folder and leaving the operator to wonder which file was meant.
    if (!existsSync(savedAs)) {
      showMessage(tr('downloadGone', { file: path.basename(savedAs) }))
      return false
    }
    shell.showItemInFolder(savedAs)
    return true
  })

  ipcMain.handle('downloads:settings-set', async (_event, changes) => {
    if (changes?.dir !== undefined) downloadDir = String(changes.dir ?? '')
    if (changes?.ask !== undefined) askWhereToSave = Boolean(changes.ask)
    await saveLayout(layoutFile, currentLayout(), legacyLayoutFile).catch(() => {})
    return downloadSettings()
  })

  // A folder, not a file. Cancelling means "leave it as it was" rather than "clear it" –
  // backing out of a picker is not a decision to change anything.
  ipcMain.handle('downloads:pick-dir', async () => {
    const result = await dialog.showOpenDialog(window, {
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: resolveDownloadDir(downloadDir, app.getPath('downloads')),
    })
    if (result.canceled || !result.filePaths.length) return null
    downloadDir = result.filePaths[0]
    await saveLayout(layoutFile, currentLayout(), legacyLayoutFile).catch(() => {})
    return downloadSettings()
  })

  // The nameplate in Settings. The manifest is the package.json electron-builder packed, which
  // is where CI leaves the build date and the commit (the Build installer step in
  // .github/workflows/build.yml); it is read from the app path, so the packaged copy and a run
  // from the sources look in the same place. The size of the profile is a separate question,
  // because answering it means walking the whole profile – see about.js.
  const manifest = JSON.parse(readFileSync(path.join(app.getAppPath(), 'package.json'), 'utf8'))

  // What each awake account costs, written down for the decision on putting accounts to sleep –
  // see account-memory.js. Taken when Settings is opened and once a quarter of an hour after the
  // start, by which time the pages have settled into what they cost for the rest of the day.
  const logAccountMemory = () => {
    if (window.isDestroyed()) return
    const metrics = app.getAppMetrics()
    for (const [accountId, account] of manager.accounts) {
      const view = manager.views.get(accountId)
      if (!view || view.webContents.isDestroyed() || view.webContents.isCrashed()) continue
      const megabytes = accountMemoryMb(metrics, processIdsOf(view.webContents))
      if (megabytes === null) continue
      logger.write('account-memory', { account: accountId, platform: account.platform, count: megabytes, reason: 'awake' })
    }
  }

  ipcMain.handle('about:get', () => {
    logAccountMemory()
    return {
      ...describeBuild(manifest, process.versions, app.isPackaged),
      profileDir: dataDir,
      homepage: manifest.homepage,
      license: manifest.license,
    }
  })

  ipcMain.handle('about:profile-size', () => directorySize(dataDir))

  // Both hand the system something THIS process chose – the profile directory it runs on and
  // the address in its own manifest. The renderer names neither, for the same reason "Show in
  // folder" is given an id rather than a path.
  ipcMain.handle('about:open-profile', () => shell.openPath(dataDir))
  ipcMain.handle('about:open-repository', () => shell.openExternal(manifest.homepage))

  ipcMain.handle('language:get', () => language)

  // Written to disk IMMEDIATELY, not only on close: choosing a language is a rare,
  // deliberate act, and losing it to a killed process would be visible from the very
  // first launch after installation. The tray menu is rebuilt because it is a
  // main-process surface the renderer cannot repaint.
  ipcMain.handle('language:set', async (_event, next) => {
    language = validLanguage(next)
    buildTray()
    refreshBadge()
    await saveLayout(layoutFile, currentLayout(), legacyLayoutFile).catch(() => {})
    return language
  })

  // app.setBadgeCount works only on Linux and macOS. On Windows the count is shown by an
  // overlay on the taskbar icon, and that needs a 16x16 image – the renderer draws it and
  // sends it back over unread:overlay. The window title and tray tooltip are the fallback,
  // visible even when the overlay does not take.
  const refreshBadge = () => {
    // Account views emit page-title-updated while the application is closing too, when
    // the window is already gone. Without this guard Electron raises "Object has been
    // destroyed" in a modal error dialog that blocks the process from exiting.
    if (!window || window.isDestroyed()) return
    const byAccount = manager.unreadByAccount()
    const total = Object.values(byAccount).reduce((sum, n) => sum + n, 0)
    // Sleeping accounts are said next to the count, wherever the count is: they are the ones it
    // cannot speak for.
    const asleep = manager.asleepIds()
    const asleepSuffix = asleep.length ? ` – ${tr('unreadAsleep', { n: asleep.length })}` : ''
    window.setTitle((total ? `M-HUB (${total})` : 'M-HUB') + asleepSuffix)
    tray?.setToolTip((total ? tr('trayUnread', { n: total }) : 'M-HUB') + asleepSuffix)
    // The renderer also gets the per-account breakdown – the rail shows a count on each – and which
    // accounts are asleep, so their channels say so instead of showing nothing new.
    if (!window.webContents.isDestroyed()) window.webContents.send('unread:changed', { total, byAccount, asleep })

    // A count being held at its last non-zero value has nothing to wake it: the page that
    // stopped blinking stopped sending titles too. One timer, rearmed on every pass, and
    // never more than one – the fifty milliseconds are there so the deadline has actually
    // passed by the time the badge is worked out again, rather than being reached exactly.
    if (badgeTimer) clearTimeout(badgeTimer)
    badgeTimer = null
    const due = manager.pendingBadgeAt()
    if (due !== null) badgeTimer = setTimeout(refreshBadge, Math.max(0, due - Date.now()) + 50)
  }

  ipcMain.handle('unread:overlay', (_event, image) => {
    window.setOverlayIcon(
      image ? nativeImage.createFromDataURL(image) : null,
      image ? tr('overlayUnread') : '',
    )
  })

  // Until this existed a link in a conversation opened a BARE Electron window: no address
  // bar, no back, no reload, and inside the account's signed-in session – measured, the
  // popup's session was the very same object as the view's. Which decision an address gets
  // is navigation.js's business; this is only the wiring.
  //
  // The sessions that already carry the download listener – see the end of gateNavigation.
  const wiredSessions = new WeakSet()
  // Account id -> the windows its page has open. Restarting the page can take them down with it,
  // and the channel menu says so before the click rather than after.
  const childWindows = new Map()

  // A page of the service, open in a window, moved into the account view – see child-windows.js.
  // Asked again here rather than trusted from the menu: the window may have moved on since the
  // menu was built. The window steps out of sight at once and closes once the view has the page;
  // if the account page refuses to be left – a draft, which the status bar then reports – or the
  // load fails, the window comes back, so the page is never lost to a move that did not happen.
  // So does a window whose own page refuses to close – a comment typed in it – because a close is
  // refused as silently as a load, and a hidden window with a draft would be out of reach for good.
  // Whether the page got there is read from what the view reports, not from loadURL's promise,
  // which the page being left can fail with an abort of its own (see landing.js).
  const openInAccountView = (accountId, child, address) => {
    const account = manager.accounts.get(accountId)
    const view = manager.liveView(accountId)
    if (!account || !view || hostClass(PLATFORMS[account.platform], address) !== 'service') return false
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send('accounts:select-id', accountId)
    const bringBack = () => {
      if (!child.isDestroyed()) child.show()
    }
    child.hide()
    loadAndLand(view.webContents, address).then((landed) => {
      if (!landed) return bringBack()
      if (child.isDestroyed()) return
      child.webContents.once('will-prevent-unload', bringBack)
      child.close()
    })
    return true
  }

  // What a window a page opened is given: the keys of a small browser and a menu that names them.
  // Its menu bar stays hidden until Alt, as Windows applications keep theirs.
  const equipChildWindow = (child, account, requested) => {
    const contents = child.webContents
    const platform = PLATFORMS[account.platform]
    // The address the window was opened for, until it has committed one of its own.
    const address = () => contents.getURL() || requested

    const act = (id) => (id === 'open-in-view' ? openInAccountView(account.id, child, address()) : runInWindow(contents, id))
    const template = () => childWindowMenuTemplate({ platform, url: address(), ...historyState(contents), tr })

    const menu = Menu.buildFromTemplate(
      template().map((group) => ({
        ...group,
        submenu: group.submenu.map((item) => (item.id ? { ...item, click: () => act(item.id) } : item)),
      })),
    )
    child.setMenu(menu)

    // What the window can do changes with every step it takes. The menu is built once and only its
    // items are switched on and off: a menu replaced while the operator has it open would be pulled
    // out from under the click.
    const refreshMenu = () => {
      if (child.isDestroyed() || contents.isDestroyed()) return
      for (const group of template()) {
        for (const item of group.submenu) {
          if (item.id) menu.getMenuItemById(item.id).enabled = item.enabled ?? true
        }
      }
    }

    contents.on('before-input-event', (event, input) => {
      const command = commandFor(input, { inChildWindow: true })
      if (!command) return
      event.preventDefault()
      runInWindow(contents, command)
    })
    child.on('app-command', (_event, name) => {
      if (Object.hasOwn(APP_COMMANDS, name)) runInWindow(contents, APP_COMMANDS[name])
    })
    contents.on('did-frame-navigate', refreshMenu)
    contents.on('did-navigate-in-page', refreshMenu)
    contents.on('did-fail-load', refreshMenu)
  }

  const gateNavigation = (view, account) => {
    const platform = PLATFORMS[account.platform]

    const sendOut = (address) => {
      shell.openExternal(address).catch(() => {})
    }

    view.webContents.setWindowOpenHandler((details) => {
      // A measurement for the decision on popups: how many of them are sign-ins, and how many
      // are articles a click opened. The class and the disposition, never the address – the
      // address is where the person or the page would be.
      logger.write('window-open', {
        account: account.id,
        platform: account.platform,
        code: hostClass(platform, details.url),
        reason: details.disposition,
      })
      const verdict = classify(platform, details.url, { viaWindowOpen: true })
      if (verdict === 'external') sendOut(details.url)
      if (verdict !== 'child') return { action: 'deny' }

      return {
        action: 'allow',
        // The child window must not outlive the page that opened it: sign-in flows answer
        // back to their opener, and one left behind is a signed-in window with no owner.
        outlivesOpener: false,
        overrideBrowserWindowOptions: {
          parent: window,
          width: 520,
          height: 700,
          autoHideMenuBar: true,
          webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
        },
      }
    })

    view.webContents.on('did-create-window', (child, details) => {
      // A window with no address bar must not be able to call itself something it is not,
      // so its title is the origin and the page may not change it. The first argument here
      // is a BrowserWindow, not a webContents.
      let origin = 'about:blank'
      try {
        origin = new URL(details.url).origin
      } catch {
        // Leave the placeholder: an address we cannot parse is exactly the case where a
        // page-chosen title would be doing the talking.
      }
      child.setTitle(origin)
      // The listener belongs on the WINDOW, not on its webContents: it is the window's
      // event whose preventDefault stops the native title from being applied. Attached to
      // the webContents the call is accepted and does nothing, which is how a guard comes
      // to look like it works.
      child.on('page-title-updated', (event) => event.preventDefault())

      if (!childWindows.has(account.id)) childWindows.set(account.id, new Set())
      const open = childWindows.get(account.id)
      open.add(child)
      child.once('closed', () => open.delete(child))

      // Looked up rather than captured, so a window opened after an edit knows the account as it is.
      equipChildWindow(child, manager.accounts.get(account.id) ?? account, details.url)
    })

    // Only will-navigate, deliberately. A redirect is the continuation of a navigation that
    // was already allowed, and sign-in flows legitimately pass through hosts nobody can
    // enumerate in advance – gating those would break the sign-in rather than protect it.
    // The rule is where a navigation CAME FROM, not where it is heading.
    view.webContents.on('will-navigate', (event, address) => {
      const verdict = classify(platform, address)
      if (verdict === 'view') return
      event.preventDefault()
      if (verdict === 'external') sendOut(address)
    })

    // Registered on the account's own partition rather than on the default session, because
    // on the default session there is no way to tell whose file is arriving. Nothing here
    // reads or touches the page: this is the browser's own download path, which section 7 of
    // the design leaves alone.
    //
    // Once per partition, not once per view. A session outlives its view – an account removed
    // and added again under the same name gets the same partition, and the same session object,
    // back – so registering with every view stacked a second listener on it, and with that a
    // second "Downloading" message and a second save path for one file. The account is looked
    // up when a file arrives, so the message names the account as it is now.
    const accountSession = view.webContents.session
    if (wiredSessions.has(accountSession)) return
    wiredSessions.add(accountSession)
    accountSession.on('will-download', (_event, item) => {
      const owner = manager.accounts.get(account.id) ?? account
      const target = resolveDownloadDir(downloadDir, app.getPath('downloads'))
      const filename = item.getFilename()

      // Which of the two happens is decided in downloads.js, where it can be tested: the
      // asking branch ends in a modal no end-to-end test can answer, so it used to be the one
      // branch nothing exercised – and it is the default.
      const plan = planSave({ ask: askWhereToSave, folder: target, filename, exists: existsSync })
      if (plan.mode === 'dialog') item.setSaveDialogOptions({ defaultPath: plan.defaultPath })
      else item.setSavePath(plan.savePath)

      const id = showMessage(tr('downloadStarted', { account: owner.name, file: filename }), { tone: 'info' })

      // The banner used to say "downloading" for the rest of the session, because nothing
      // ever asked the download how it went.
      item.once('done', (_doneEvent, state) => {
        if (state !== 'completed') {
          logger.write('download-failed', { account: account.id, reason: state })
          showMessage(tr(state === 'cancelled' ? 'downloadCancelled' : 'downloadFailed', { file: filename }), {
            id,
            tone: 'error',
          })
          return
        }
        const savedAs = item.getSavePath()
        downloads.set(id, savedAs)
        showMessage(tr('downloadSaved', { file: path.basename(savedAs) }), {
          id,
          tone: 'info',
          autoHideMs: DOWNLOAD_MESSAGE_MS,
          offer: { action: 'show-download', downloadId: id },
        })
      })
    })
  }

  const prepareView = (view, account) => {
    // The account object is re-read rather than captured, so turning notifications off in
    // Settings takes effect on the next request instead of on the next restart. A page asks
    // once and remembers the answer, so a refusal also needs the page reloading – which the
    // status bar offers anyway.
    view.webContents.session.setPermissionRequestHandler(async (_wc, permission, grant) => {
      if (permission !== 'notifications') return grant(false)
      const { accounts } = await loadAccounts(path.join(dataDir, 'accounts.json'))
      grant(notificationsAllowed(accounts.find((a) => a.id === account.id) ?? account))
    })
    view.webContents.on('page-title-updated', refreshBadge)
    attachShortcuts(view.webContents)
    gateNavigation(view, account)

    // Every step the page takes can change where Back and Forward lead: a load, a step inside the
    // page – which is how Facebook moves between a profile, a post and a photo – and a step inside
    // one of its frames. And a load that failed: its error page is a step in the history too, and
    // Electron reports it only as a failure, never as a navigation – offline, Start would leave
    // Back greyed over a page it can go back from. Only the account being looked at has buttons.
    const navigated = () => {
      if (manager.activeId === account.id) sendNavState(account.id)
    }
    view.webContents.on('did-frame-navigate', navigated)
    view.webContents.on('did-navigate-in-page', navigated)
    view.webContents.on('did-fail-load', navigated)

    // Clicking a Windows toast hands focus to the view the toast came from, and nothing
    // else moved with it: the rail went on showing the account the operator had walked
    // away from, and the conversation they were sent to opened inside a view zero pixels
    // tall. The renderer is asked to switch, for the same reason as Ctrl+1..9 – it owns
    // switching, and going round it desynchronises the rail.
    //
    // show() ends by focusing the view it just showed, so answering every focus event
    // would be a loop that never stops. A view that is already current asks for nothing.

    // A dead renderer shows a blank rectangle and nothing else. Saying so, and saying which
    // account it happened to, is the difference between a bug report and a restart.
    //
    // Unless the application ended the renderer itself, to restart a page that had hung: that
    // exit is reported like any crash, and announcing it would tell the operator about a crash
    // nobody had.
    //
    // Nor a view put to sleep: the operator closed it, and nothing it reports on the way out is news.
    const goingOrGone = () => manager.isFallingAsleep(account.id) || manager.isAsleep(account.id)
    view.webContents.on('render-process-gone', (_event, details) => {
      if (goingOrGone()) return
      if (manager.takeExpectedExit(account.id)) {
        logger.write('account-restarted', { account: account.id })
        return
      }
      logger.write('account-crashed', { account: account.id, reason: details.reason })
      showMessage(tr('accountCrashed', { account: account.name, reason: details.reason }), {
        offer: { action: 'reload', accountId: account.id },
      })
    })

    // A hung page does not answer a reload – the request waits behind the very script that
    // hung – so what is offered here is a restart of the renderer.
    view.webContents.on('unresponsive', () => {
      if (goingOrGone()) return
      logger.write('account-unresponsive', { account: account.id })
      showMessage(tr('accountUnresponsive', { account: account.name }), {
        offer: { action: 'reload', accountId: account.id, command: 'restart' },
      })
    })

    // The page refused to be left – it holds something unsent – and Electron has quietly
    // cancelled whatever was leaving it. Said out loud, with an offer to go ahead only when the
    // refusal answers something just asked for here; the page's own navigations and the mouse's
    // back button are refused the same way, and for those there is nothing to repeat.
    view.webContents.on('will-prevent-unload', (event) => {
      if (guard.allowed(account.id)) {
        event.preventDefault()
        return
      }
      // The reload never started, so no load will finish and take the account out of settling:
      // left there, it would stop a clicked notification from ever switching to it again.
      settling.delete(account.id)
      // A sleep refused is an account that stays awake, its view where it was. The offer then says
      // what going ahead means – putting it to sleep, not discarding something to stay.
      if (manager.isFallingAsleep(account.id)) {
        manager.stayAwake(account.id)
        sleepNotes.delete(account.id)
      }
      const action = guard.blocked(account.id)
      logger.write('account-unload-refused', { account: account.id, platform: account.platform, reason: action ?? 'page' })
      showMessage(tr('unsavedChanges', { account: account.name }), {
        tone: 'info',
        offer: action ? { action: 'proceed', accountId: account.id, command: action } : null,
      })
    })

    // A view also takes the system's focus while it is being created, and that is not a
    // notification click: measured, two accounts produced two such events, both from a
    // webContents still loading with an empty URL, and which account came out current was
    // left to whichever landed last. A toast cannot come from a page that has never
    // loaded, so nothing is routed until the first load has finished, one way or the other –
    // and the same holds for every reload asked for here, which loads the page again while
    // the operator is, as often as not, looking at a different account.
    //
    // Those focus events were Electron focusing a view on every navigation, and so were the ones
    // from a page reloading by itself, which nothing here knew to wait for. createView now turns
    // that off (focusOnNavigation); this set stays as the second guard it costs nothing to keep.
    settling.add(account.id)
    view.webContents.on('did-stop-loading', () => settling.delete(account.id))

    view.webContents.on('focus', () => {
      if (settling.has(account.id) || goingOrGone()) return
      if (manager.activeId === account.id) return
      if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return
      window.webContents.send('accounts:select-id', account.id)
    })
  }

  // ORDER MATTERS: the renderer calls accounts:list the moment it loads, so the views
  // and the IPC channels must stand BEFORE loadFile. The other way round yields
  // "No handler registered for 'accounts:list'" and an empty rail.
  const { accounts } = await loadAccounts(path.join(dataDir, 'accounts.json'))

  // A quit can arrive while the accounts file is being read – Playwright's close() did, on CI,
  // 2026-09-07 – and Electron then closes the window on its own, because the close handler
  // further down has not been attached yet. Nothing after this line has any business running
  // for a window that is gone: the views would be added to it, the shortcut registered for it,
  // and fitViews would throw "Object has been destroyed" into an unhandled rejection, which is
  // the kind of exception that has blocked an exit before. A start that was quit before it
  // finished also leaves no started line, which is what it ought to look like. The flag
  // before-quit sets is asked first: it is raised before Electron starts closing windows,
  // so it says so earlier than the window can.
  if (quitting || window.isDestroyed()) return

  // Here rather than at the top of this function, because here the number is known. The line
  // used to be written the moment the logger existed and carried a hardcoded zero, so it said
  // nothing at all – and the one question it should answer is the first a helper asks when
  // somebody reports that their accounts are gone. A start that never reaches this point
  // leaves no started line, which is what failing to start ought to look like.
  logger.write('started', { count: accounts.length })

  for (const account of accounts) prepareView(manager.add(account), account)
  fitViews()
  if (accounts.length) manager.show(accounts[0].id)

  registerAccountChannels({
    dataDir,
    manager,
    onAccountsChanged: fitViews,
    prepareView,
    onAccountShown: sendNavState,
    wakeAccount,
    onAccountRemoved: (accountId) => {
      reminder.woke(accountId)
      sleepNotes.delete(accountId)
      refreshBadge()
    },
  })
  clipboardSession = createClipboardSession()
  clipboardSession.warmUp()
  registerMacroChannels({ dataDir, manager, clipboardSession })

  // loadFile rejects with ERR_FAILED when the window goes away underneath it – that is the
  // same quit arriving a moment later, not a failure to load. Electron rejects it BEFORE the
  // window reports itself destroyed (measured 2026-09-08), so the flag is what says it was
  // the quit; the window is asked as well, for a close that did not come through app.quit().
  try {
    await window.loadFile(path.join(HERE, '..', 'renderer', 'index.html'))
  } catch (error) {
    if (quitting || window.isDestroyed()) return
    throw error
  }
  if (quitting || window.isDestroyed()) return
  refreshBadge()
  setTimeout(logAccountMemory, ACCOUNT_MEMORY_AFTER_MS)

  // A laptop coming back from sleep leaves the services believing the computer is gone.
  // Reloading by itself would throw away whatever the operator was in the middle of typing
  // before the lid closed, so waking only says the accounts may need it.
  //
  // Sleeping accounts are said in the same message. The application did not restart, so the rule
  // that every account wakes at the start did not reach them, and they are offered back – one
  // button beside the reload – never woken behind the operator's back.
  powerMonitor.on('resume', () => {
    logger.write('woke-up', {})
    const asleep = reminder.due('resume')
    if (!manager.activeId && !asleep) return
    const text = asleep ? `${tr('wokeUp')} ${tr('asleepReminder', { n: asleep })}` : tr('wokeUp')
    const offer = manager.activeId
      ? { action: 'reload', accountId: manager.activeId, wakeAll: asleep > 0 }
      : { action: 'wake-all' }
    showMessage(text, { offer })
  })

  // The window back from the tray, from a second launch or from the macro shortcut is the other
  // moment an account left asleep is easy to forget. Only once a sleep has lasted, and not every
  // time – see sleep.js.
  window.on('show', () => {
    const asleep = reminder.due('show')
    if (asleep) showMessage(tr('asleepReminder', { n: asleep }), { tone: 'info', offer: { action: 'wake-all' } })
  })

  // The one shortcut that has to work when the app is not in front at all – that is the
  // whole point of a macro palette for someone typing in another program. register()
  // answers with a boolean and says nothing when another program already owns the
  // combination, and silence would look exactly like a shortcut that works.
  const claimed = globalShortcut.register(MACRO_SHORTCUT, () => {
    if (!window || window.isDestroyed()) return
    if (!window.isVisible()) window.show()
    if (window.isMinimized()) window.restore()
    window.focus()
    window.webContents.focus()
    window.webContents.send('macros:open')
  })
  if (!claimed) {
    logger.write('global-shortcut-refused', {})
    showMessage(tr('shortcutTaken', { shortcut: MACRO_SHORTCUT }))
  }

  // Saving the layout must FINISH before the window closes – otherwise app.quit() cuts
  // the asynchronous write short and the window position does not survive a restart. The
  // same write has to happen on the way to the tray, because from there the process may
  // well end without another close ever being seen.
  let layoutSaved = false
  window.on('close', (event) => {
    if (layoutSaved) return
    event.preventDefault()
    const goingToTray = closeToTray && !quitting
    saveLayout(layoutFile, currentLayout(), legacyLayoutFile).finally(() => {
      if (goingToTray) {
        window.hide()
        return
      }
      layoutSaved = true
      window.destroy()
    })
  })
}

// Rebuilt rather than mutated, because Electron's Menu is immutable once set – this is
// also how the tray follows a language change.
function buildTray() {
  if (!tray) {
    // An empty tray icon is INVISIBLE on Windows – it has to be a real image.
    tray = new Tray(nativeImage.createFromPath(TRAY_ICON).resize({ width: 16, height: 16 }))
    tray.setToolTip('M-HUB')
    tray.on('click', () => (window?.isVisible() ? window.hide() : window?.show()))
  }
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: tr('trayShow'), click: () => window?.show() },
      {
        label: tr('trayAutoStart'),
        type: 'checkbox',
        checked: isAutoStartOn(app),
        click: (item) => setAutoStart(item.checked, app),
      },
      {
        // The log only earns its keep if the person it is for can find it. Everything in it
        // is written by this app and is safe to send on – see src/main/log.js.
        label: tr('trayOpenLogs'),
        click: () => {
          if (logDir) shell.openPath(logDir)
        },
      },
      { type: 'separator' },
      {
        label: tr('trayQuit'),
        click: () => {
          quitting = true
          app.quit()
        },
      },
    ]),
  )
}

// Two copies over one profile is not a tidiness problem: each keeps its own picture of the
// cookie stores, and whichever loses the write loses its sign-in. On WhatsApp that means
// scanning a QR code again, and which copy loses is not predictable. The lock has to be
// taken BEFORE whenReady, or the second copy gets far enough to build a window first.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  // Launching again is someone asking to see the app, and usually it is in the tray.
  app.on('second-instance', () => {
    if (!window || window.isDestroyed()) return
    if (!window.isVisible()) window.show()
    if (window.isMinimized()) window.restore()
    window.focus()
  })

  app.whenReady().then(async () => {
    await createWindow()
    // A start that was quit halfway through has no window to put in the tray, and a tray icon
    // with no window behind it would keep the process alive for nothing.
    if (window && !window.isDestroyed()) buildTray()
  })
}

// Anything that ends the application – the tray menu, a session ending, a task manager –
// arrives here first, and from here on a close means a close.
app.on('before-quit', () => {
  quitting = true
  globalShortcut.unregisterAll()
  clipboardSession?.close()
  // A pending badge recheck would reach for a window that is on its way out.
  if (badgeTimer) clearTimeout(badgeTimer)
  badgeTimer = null
})

app.on('window-all-closed', () => app.quit())
