import { WebContentsView } from 'electron'
import { PLATFORMS } from './accounts.js'
import { UnreadLatch } from './unread.js'

// Electron assembles the default User-Agent out of the application's own name and version, so
// whatever this application is called goes out to Meta's servers on every request unless it is
// taken out here.
//
// The name is an ARGUMENT and not a literal. Written into the expression – as `msg-hub` was –
// it stops matching on the day the application is renamed, and it fails in the quietest way
// there is: the new name simply starts appearing in the User-Agent, while the test guarding
// this stays green, because the test was written against the old literal too.
const isOwnToken = (token, name) =>
  Boolean(name) && token.toLowerCase().startsWith(String(name).toLowerCase() + '/')

export function cleanUserAgent(defaultUA, appName) {
  return String(defaultUA)
    .split(/\s+/)
    .filter((token) => !isOwnToken(token, 'Electron') && !isOwnToken(token, appName))
    .join(' ')
    .trim()
}

// LinkedIn's own title writer, lifted from its production bundle:
//   document.title = r > 99 ? `(99+) ${e}` : r > 0 ? `(${r}) ${e}` : e
// A pattern demanding digits and then a closing bracket reads "(99+) LinkedIn" as zero, so
// the badge disappeared exactly when the account was busiest. LinkedIn's own clean-up regex
// treats the plus as a first-class case – \(\d+\+?\) – and so does this one.
export function unreadFromTitle(title) {
  const hit = /^\((\d+)\+?\)/.exec(String(title || '').trim())
  return hit ? Number(hit[1]) : 0
}

// The view class is a parameter so the options can be examined without a running Electron
// main process, the same way createClipboardSession takes its spawn function.
export function createView(account, defaultUA, onError = () => {}, View = WebContentsView) {
  const view = new View({
    webPreferences: {
      partition: `persist:${account.id}`,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Chromium treats a view of zero height as a hidden tab and slows its timers by an
      // order of magnitude – measured 2026-08-25: 101 ticks of a 100 ms timer in ten
      // seconds while active, 10 while hidden. Every account but the current one is
      // exactly that, and once the window goes to the tray so is the current one, which
      // is the state this application exists to be useful in.
      backgroundThrottling: false,
    },
  })
  // No name here on purpose: the string this receives has already been through
  // cleanUserAgent with the application's name, in main.js, before any window exists. This
  // pass is a guard against a caller that hands over a raw one, and it can still take out
  // the marker that does not depend on knowing the name.
  view.webContents.setUserAgent(cleanUserAgent(defaultUA))

  // Spec section 8: a failed load must produce a visible message, not a blank window.
  // A rejection based on the User-Agent cannot be detected programmatically without
  // reading the page DOM, and that would break rule 7.2 – so the message names both
  // possible causes instead of guessing.
  view.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return // -3 = aborted by the user
    onError({ account, code, description, url })
  })

  view.webContents.loadURL(account.url)
  return view
}

// How long after a restart its own crash report is waited for. The report is one task away, so
// this is generous by orders of magnitude; what it must not be is open-ended.
const EXPECTED_EXIT_MS = 5000

export class ViewManager {
  // The clock is a parameter for the same reason createView takes its view class: the rule
  // the latch enforces is about elapsed time, and it has to be examinable without waiting.
  constructor(window, defaultUA, onError = () => {}, { now = () => Date.now() } = {}) {
    this.window = window
    this.defaultUA = defaultUA
    this.onError = onError
    this.now = now
    // What a page CLAIMS is not what the rail shows: a page with something waiting blinks its
    // own title, and the count has to survive the half of that blink which says zero.
    this.latch = new UnreadLatch()
    this.views = new Map()
    // Whether an account's page title carries a count worth showing. Declared per platform
    // in accounts.js and kept here, because this is where the badge is worked out and a
    // view on its own knows nothing about which service it is.
    this.countsUnread = new Map()
    // The account each view was made for. A reload that finds nothing to reload needs the
    // account's own address to start again from, and the view does not know it.
    this.accounts = new Map()
    // Account id -> until when a crash report is expected, because a restart caused it.
    this.expectedExits = new Map()
    this.activeId = null
    this.visible = true
    this.geometry = { x: 0, y: 0, width: 0, height: 0 }
  }

  add(account) {
    if (this.views.has(account.id)) return this.views.get(account.id)
    this.countsUnread.set(account.id, PLATFORMS[account.platform]?.unreadInTitle !== false)
    this.accounts.set(account.id, account)
    const view = createView(account, this.defaultUA, this.onError)
    view.setVisible(this.visible)
    this.window.contentView.addChildView(view)
    view.setBounds({ ...this.geometry, height: 0 })
    this.views.set(account.id, view)
    return view
  }

  // An edit keeps the view and its sign-in – the id does not change – but the name and the
  // rest are read from here by whatever names the account later: the channel menu, a download
  // message. Only an account that already has a view is replaced; adding one is add()'s job.
  update(account) {
    if (this.views.has(account.id)) this.accounts.set(account.id, account)
  }

  remove(accountId) {
    const view = this.views.get(accountId)
    if (!view) return false
    this.window.contentView.removeChildView(view)
    // Listeners come off BEFORE closing – otherwise the closing view still manages
    // to fire a callback that reaches for an object which no longer exists.
    view.webContents.removeAllListeners('page-title-updated')
    view.webContents.removeAllListeners('did-fail-load')
    view.webContents.close()
    this.views.delete(accountId)
    this.countsUnread.delete(accountId)
    this.accounts.delete(accountId)
    this.expectedExits.delete(accountId)
    this.latch.forget(accountId)
    if (this.activeId === accountId) {
      this.activeId = null
      const next = this.views.keys().next()
      if (!next.done) this.show(next.value)
    }
    return true
  }

  show(accountId) {
    if (!this.views.has(accountId)) return
    this.activeId = accountId
    for (const [id, view] of this.views) {
      view.setBounds(id === accountId ? this.geometry : { ...this.geometry, height: 0 })
    }
    this.views.get(accountId).webContents.focus()
  }

  // The only way back into a view that has gone stale – a laptop waking to find WhatsApp
  // saying the computer is not connected – used to be restarting the application and taking
  // every other account down with it. Reloading throws away whatever is half-typed in the
  // composer, so this is never called on a timer; something has to ask for it.
  //
  // Three ways, because a white rectangle has more than one cause:
  //   'normal'   the page reloads. After a load that failed while the network was down, this
  //              retries the address the error page stands in for, not the error page.
  //   'hard'     the same past the HTTP cache and the service worker – for a page that keeps
  //              coming back broken from what it saved.
  //   'restart'  the renderer is ended and the page loaded into a new one. A hung renderer does
  //              not answer a reload: the request waits behind the very script that hung.
  //              Partitions never share a renderer, so no other account goes down with it.
  reload(accountId, mode = 'normal') {
    const view = this.views.get(accountId)
    if (!view || view.webContents.isDestroyed()) return false
    const contents = view.webContents

    // Nothing ever committed – the first load is still on its way, or was abandoned. reload()
    // on an empty history does nothing and says nothing, which on a blank view would make F5
    // look dead exactly where it is pressed.
    if (!contents.getURL() || contents.navigationHistory.length() === 0) {
      const account = this.accounts.get(accountId)
      if (!account) return false
      contents.loadURL(account.url).catch(() => {})
      return true
    }

    if (mode === 'restart' && !contents.isCrashed()) {
      // The crash this causes is reported a task later, like any other. Expected for a few
      // seconds and no longer, so a real crash later on is never mistaken for this one.
      this.expectedExits.set(accountId, this.now() + EXPECTED_EXIT_MS)
      contents.forcefullyCrashRenderer()
    }

    if (mode === 'hard') contents.reloadIgnoringCache()
    else contents.reload()
    return true
  }

  // Whether a crash report for this account was caused by a restart. Answered once: the
  // expectation is spent by the report it was for.
  takeExpectedExit(accountId) {
    const until = this.expectedExits.get(accountId)
    this.expectedExits.delete(accountId)
    return until !== undefined && this.now() <= until
  }

  setGeometry(rect) {
    this.geometry = rect
    if (this.activeId) this.show(this.activeId)
  }

  // Account views are a native layer ABOVE the renderer, so every renderer dialog
  // would vanish underneath them. The whole layer steps aside while a dialog is open.
  setVisibility(visible) {
    this.visible = Boolean(visible)
    for (const view of this.views.values()) view.setVisible(this.visible)
  }

  active() {
    return this.activeId ? this.views.get(this.activeId) ?? null : null
  }

  all() {
    return this.views
  }

  // The channel rail shows a count next to EVERY account, so a bare total is not enough.
  unreadByAccount() {
    const result = {}
    const now = this.now()
    for (const [id, view] of this.views) {
      if (view.webContents.isDestroyed()) continue
      // A service that does not count messages shows nothing rather than something that
      // looks like a message count and is not one.
      const claimed = this.countsUnread.get(id) === false ? 0 : unreadFromTitle(view.webContents.getTitle())
      this.latch.report(id, claimed, now)
      result[id] = this.latch.value(id, now)
    }
    return result
  }

  // When a held zero falls due, or null when nothing is being held. Main arms a timer for
  // this moment: a page that has stopped blinking has stopped sending titles too, and without
  // it the last count would stay on the badge for good.
  pendingBadgeAt() {
    return this.latch.dueAt()
  }

  unreadTotal() {
    return Object.values(this.unreadByAccount()).reduce((sum, n) => sum + n, 0)
  }
}
