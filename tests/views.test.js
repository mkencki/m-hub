import { describe, test, expect } from 'vitest'
import { EventEmitter } from 'node:events'
import { unreadFromTitle, cleanUserAgent, createView, ViewManager, wakeIndex } from '../src/main/views.js'

describe('cleanUserAgent', () => {
  test('strips the Electron marker', () => {
    const ua = cleanUserAgent('Mozilla/5.0 Chrome/141.0.0.0 Electron/43.4.1 Safari/537.36')
    expect(ua).not.toMatch(/Electron/)
    expect(ua).toContain('Chrome/141.0.0.0')
  })

  // Electron builds the default User-Agent out of the application's own name, so this
  // function had that name written into it as a literal. Rename the application and the
  // literal stops matching – quietly, with the new name going out to Meta's servers on
  // every request. The name is a parameter for that reason, and these two cases are the
  // same string with a different name in it.
  test('strips the application name it is given', () => {
    expect(cleanUserAgent('Mozilla/5.0 msg-hub/0.1.0 Chrome/141.0.0.0', 'msg-hub')).not.toMatch(
      /msg-hub/i,
    )
  })

  test('strips a different application name just as well', () => {
    expect(cleanUserAgent('Mozilla/5.0 M-HUB/0.5.0 Chrome/141.0.0.0', 'M-HUB')).not.toMatch(
      /M-HUB/i,
    )
  })

  test('leaves the rest of the string alone', () => {
    const ua = cleanUserAgent('Mozilla/5.0 (Windows NT 10.0) M-HUB/0.5.0 Chrome/141.0.0.0', 'M-HUB')
    expect(ua).toBe('Mozilla/5.0 (Windows NT 10.0) Chrome/141.0.0.0')
  })
})

describe('unreadFromTitle', () => {
  test('reads the counter out of the parentheses', () => {
    expect(unreadFromTitle('(3) WhatsApp')).toBe(3)
  })

  test('reads a multi-digit counter', () => {
    expect(unreadFromTitle('(12) Messenger')).toBe(12)
  })

  test('no counter yields zero', () => {
    expect(unreadFromTitle('WhatsApp')).toBe(0)
  })

  test('an empty title yields zero', () => {
    expect(unreadFromTitle('')).toBe(0)
  })
})

describe('createView', () => {
  // A stand-in for WebContentsView: the question is what options the constructor is handed,
  // and a real one needs a running Electron main process to exist at all.
  class RecordingView {
    constructor(options) {
      RecordingView.lastOptions = options
      this.webContents = { setUserAgent() {}, on() {}, loadURL() {} }
    }
  }

  const account = { id: 'acc-sample', url: 'https://example.test/', name: 'Sample' }

  // Chromium treats a view of zero height as a hidden tab and slows its timers by an order
  // of magnitude – measured 2026-08-25: 101 ticks of a 100 ms timer in ten seconds while
  // active, 10 while hidden. Every account but the current one is exactly that, and once
  // the window is in the tray so is the current one. An app whose whole purpose is to
  // notice messages arriving must not slow its awake accounts down to save a little battery.
  // Putting an account to sleep is something else: the operator's explicit choice to give up
  // that account's notifications, made by hand, which closes the page outright.
  test('an account in the background keeps running at full speed', () => {
    createView(account, 'UA', () => {}, RecordingView)

    expect(RecordingView.lastOptions.webPreferences.backgroundThrottling).toBe(false)
  })

  test('the isolated partition and the sandbox are not given up along the way', () => {
    createView(account, 'UA', () => {}, RecordingView)

    const preferences = RecordingView.lastOptions.webPreferences
    expect(preferences.partition).toBe('persist:acc-sample')
    expect(preferences.sandbox).toBe(true)
    expect(preferences.contextIsolation).toBe(true)
    expect(preferences.nodeIntegration).toBe(false)
  })
})

describe('unreadFromTitle at the edges', () => {
  // LinkedIn's own title writer, lifted from its production bundle:
  //   document.title = r > 99 ? `(99+) ${e}` : r > 0 ? `(${r}) ${e}` : e
  // The old pattern demanded digits and a closing bracket, so it read "(99+) LinkedIn" as
  // zero – the badge vanished exactly when the account was busiest.
  test('a service that says 99+ is not read as nothing', () => {
    expect(unreadFromTitle('(99+) LinkedIn')).toBe(99)
  })

  test('an ordinary count still reads as itself', () => {
    expect(unreadFromTitle('(7) LinkedIn')).toBe(7)
  })

  test('a plus somewhere else in the title is not a count', () => {
    expect(unreadFromTitle('Google+ – WhatsApp')).toBe(0)
    expect(unreadFromTitle('(+) WhatsApp')).toBe(0)
  })
})

describe('reloading an account', () => {
  // A webContents that writes down what it was asked to do, in order, and answers the questions
  // reload() asks before choosing what to do.
  const recordingView = ({ url = 'https://web.whatsapp.com/', entries = 1, crashed = false, destroyed = false } = {}) => {
    const calls = []
    return {
      calls,
      setBounds() {},
      setVisible() {},
      webContents: {
        isDestroyed: () => destroyed,
        isCrashed: () => crashed,
        getURL: () => url,
        navigationHistory: { length: () => entries },
        reload: () => calls.push('reload'),
        reloadIgnoringCache: () => calls.push('reloadIgnoringCache'),
        forcefullyCrashRenderer: () => calls.push('forcefullyCrashRenderer'),
        loadURL: (address) => {
          calls.push(`loadURL ${address}`)
          return Promise.resolve()
        },
      },
    }
  }

  const account = { id: 'acc-w', platform: 'whatsapp', url: 'https://web.whatsapp.com/' }

  const managerHolding = (view, { now = () => 0 } = {}) => {
    const manager = new ViewManager({ contentView: { addChildView() {} } }, 'UA', () => {}, { now })
    manager.views.set(account.id, view)
    manager.accounts.set(account.id, account)
    return manager
  }

  test('an ordinary reload asks the page to reload', () => {
    const view = recordingView()
    expect(managerHolding(view).reload(account.id)).toBe(true)
    expect(view.calls).toEqual(['reload'])
  })

  test('a hard reload goes past the cache', () => {
    const view = recordingView()
    managerHolding(view).reload(account.id, 'hard')
    expect(view.calls).toEqual(['reloadIgnoringCache'])
  })

  // A view whose first load never committed has nothing to reload: reload() on an empty history
  // does nothing and says nothing, so F5 would look dead on exactly the white rectangle it is
  // pressed on. The account's own address is the page to go back to.
  test('a view with nothing loaded yet is sent to the account address', () => {
    const view = recordingView({ url: '', entries: 0 })
    managerHolding(view).reload(account.id)
    expect(view.calls).toEqual(['loadURL https://web.whatsapp.com/'])
  })

  // A hung renderer does not answer a reload – the request waits behind the very script that
  // hung. Electron documents ending the renderer and reloading as the way out, and partitions
  // never share a renderer process, so no other account goes down with it.
  test('a restart ends the renderer and reloads', () => {
    const view = recordingView()
    managerHolding(view).reload(account.id, 'restart')
    expect(view.calls).toEqual(['forcefullyCrashRenderer', 'reload'])
  })

  test('a renderer that is already dead is reloaded, not ended again', () => {
    const view = recordingView({ crashed: true })
    managerHolding(view).reload(account.id, 'restart')
    expect(view.calls).toEqual(['reload'])
  })

  test('an account without a view, or with a destroyed one, is not reloaded', () => {
    const manager = managerHolding(recordingView({ destroyed: true }))
    expect(manager.reload(account.id)).toBe(false)
    expect(manager.reload('acc-missing')).toBe(false)
  })

  // Ending the renderer on purpose fires render-process-gone like any crash, and the account
  // would then announce a crash nobody had. The report arrives a task later, so the manager
  // remembers that one is expected – and forgets it after a while, so a real crash later on is
  // never swallowed by a restart nobody saw finish.
  test('a restart makes the crash it causes expected, once and not for long', () => {
    let clock = 1000
    const manager = managerHolding(recordingView(), { now: () => clock })

    manager.reload(account.id, 'restart')
    expect(manager.takeExpectedExit(account.id)).toBe(true)
    expect(manager.takeExpectedExit(account.id)).toBe(false)

    manager.reload(account.id, 'restart')
    clock += 10_000
    expect(manager.takeExpectedExit(account.id)).toBe(false)
  })

  test('an ordinary reload expects no crash', () => {
    const manager = managerHolding(recordingView())
    manager.reload(account.id)
    expect(manager.takeExpectedExit(account.id)).toBe(false)
  })
})

describe('stepping through an account history', () => {
  // A webContents with a history of its own: where it stands and how far it reaches either way.
  // It writes down what it was asked to do, so a test can tell a step from a load.
  const viewWithHistory = ({ back = false, forward = false, destroyed = false } = {}) => {
    const calls = []
    return {
      calls,
      webContents: {
        isDestroyed: () => destroyed,
        navigationHistory: {
          canGoBack: () => back,
          canGoForward: () => forward,
          goBack: () => calls.push('goBack'),
          goForward: () => calls.push('goForward'),
          goToOffset: (offset) => calls.push(`goToOffset ${offset}`),
        },
        loadURL: (address) => {
          calls.push(`loadURL ${address}`)
          return Promise.resolve()
        },
      },
    }
  }

  const account = { id: 'acc-f', platform: 'facebook', url: 'https://www.facebook.com/' }

  const managerHolding = (view) => {
    const manager = new ViewManager({ contentView: { addChildView() {} } }, 'UA')
    manager.views.set(account.id, view)
    manager.accounts.set(account.id, account)
    return manager
  }

  test('back and forward take one step each', () => {
    const view = viewWithHistory({ back: true, forward: true })
    const manager = managerHolding(view)
    expect(manager.goBack(account.id)).toBe(true)
    expect(manager.goForward(account.id)).toBe(true)
    expect(view.calls).toEqual(['goBack', 'goForward'])
  })

  // Chromium answers "no" for entries a page added before anybody touched it – the way a page
  // builds a trap that Back cannot leave. goToOffset(-1) would walk into them anyway, so nothing
  // here reaches past the answer: no step is taken, and the caller is told so.
  test('a step with nowhere to go is not taken, and not forced', () => {
    const view = viewWithHistory()
    const manager = managerHolding(view)
    expect(manager.goBack(account.id)).toBe(false)
    expect(manager.goForward(account.id)).toBe(false)
    expect(view.calls).toEqual([])
  })

  // Not the first entry of the history: that is as often as not a sign-in or a checkpoint page.
  // A load of the account's own address puts the start page on top, so Back afterwards returns to
  // wherever the operator was.
  test('home loads the account address as a new step', () => {
    const view = viewWithHistory({ back: true })
    expect(managerHolding(view).goHome(account.id)).toBe(true)
    expect(view.calls).toEqual(['loadURL https://www.facebook.com/'])
  })

  test('says which ways an account can go', () => {
    expect(managerHolding(viewWithHistory({ back: true })).navState(account.id)).toEqual({
      canGoBack: true,
      canGoForward: false,
    })
    expect(managerHolding(viewWithHistory({ forward: true })).navState(account.id)).toEqual({
      canGoBack: false,
      canGoForward: true,
    })
  })

  test('an account without a view, or with a destroyed one, goes nowhere', () => {
    const manager = managerHolding(viewWithHistory({ back: true, forward: true, destroyed: true }))
    expect(manager.goBack(account.id)).toBe(false)
    expect(manager.goForward(account.id)).toBe(false)
    expect(manager.goHome(account.id)).toBe(false)
    expect(manager.goBack('acc-missing')).toBe(false)
    expect(manager.goHome('acc-missing')).toBe(false)
    expect(manager.navState(account.id)).toEqual({ canGoBack: false, canGoForward: false })
    expect(manager.navState('acc-missing')).toEqual({ canGoBack: false, canGoForward: false })
  })
})

describe('the accounts the manager knows', () => {
  const account = { id: 'acc-w', name: 'WhatsApp', platform: 'whatsapp', url: 'https://web.whatsapp.com/' }

  const managerHolding = () => {
    const manager = new ViewManager({ contentView: { addChildView() {} } }, 'UA')
    manager.views.set(account.id, { webContents: { isDestroyed: () => false } })
    manager.accounts.set(account.id, account)
    return manager
  }

  // The channel menu names the account it acts on, and a rename keeps the view and its
  // sign-in. A manager that went on holding the account as it was added would label the menu
  // with a name the rail no longer shows.
  test('an account edited while the app runs is known as it is now', () => {
    const manager = managerHolding()
    manager.update({ ...account, name: 'WhatsApp work' })
    expect(manager.accounts.get(account.id).name).toBe('WhatsApp work')
  })

  test('an update for an account without a view adds nothing', () => {
    const manager = managerHolding()
    manager.update({ ...account, id: 'acc-missing' })
    expect(manager.accounts.has('acc-missing')).toBe(false)
  })
})

describe('which accounts the badge believes', () => {
  const fakeView = (title) => ({
    webContents: { isDestroyed: () => false, getTitle: () => title },
    setBounds() {},
    setVisible() {},
  })

  const managerWith = (entries) => {
    const manager = new ViewManager({ contentView: { addChildView() {} } }, 'UA')
    for (const [id, title, unreadInTitle] of entries) {
      manager.views.set(id, fakeView(title))
      manager.countsUnread.set(id, unreadInTitle)
    }
    return manager
  }

  test('a messenger title is counted', () => {
    expect(managerWith([['acc-w', '(3) WhatsApp', true]]).unreadByAccount()).toEqual({ 'acc-w': 3 })
  })

  // The declaration has to reach the badge, or it is a comment rather than a switch.
  test('a service that does not count messages shows nothing, whatever its title says', () => {
    expect(managerWith([['acc-l', '(12) LinkedIn', false]]).unreadByAccount()).toEqual({ 'acc-l': 0 })
  })

  test('the total leaves out the accounts that are not counting', () => {
    const manager = managerWith([
      ['acc-w', '(3) WhatsApp', true],
      ['acc-l', '(12) LinkedIn', false],
    ])
    expect(manager.unreadTotal()).toBe(3)
  })
})

describe('putting an account to sleep', () => {
  // Stand-ins for a WebContentsView, its webContents and the window they sit in. Close is only
  // written down: a real one ends in Electron destroying the contents, which a test does by hand
  // with finishClosing() – or never, when the page refused.
  class FakeContents extends EventEmitter {
    constructor(view) {
      super()
      this.view = view
      this.closes = []
      this.destroyed = false
      this.audible = false
      this.title = ''
    }
    setUserAgent() {}
    loadURL() {
      return Promise.resolve()
    }
    isDestroyed() {
      return this.destroyed
    }
    isCurrentlyAudible() {
      return this.audible
    }
    getTitle() {
      return this.title
    }
    focus() {}
    close(options) {
      this.closes.push({ options: options ?? null, attached: this.view.window.contentView.children.includes(this.view) })
    }
    finishClosing() {
      this.destroyed = true
      this.emit('destroyed')
    }
  }

  class FakeView {
    constructor(options) {
      this.options = options
      this.webContents = new FakeContents(this)
    }
    setBounds(bounds) {
      this.bounds = bounds
    }
    setVisible(visible) {
      this.visible = visible
    }
  }

  const fakeWindow = () => {
    const window = {
      destroyed: false,
      isDestroyed: () => window.destroyed,
      contentView: {
        children: [],
        addChildView(view, index) {
          view.window = window
          if (index === undefined) window.contentView.children.push(view)
          else window.contentView.children.splice(index, 0, view)
        },
        removeChildView(view) {
          const at = window.contentView.children.indexOf(view)
          if (at >= 0) window.contentView.children.splice(at, 1)
        },
      },
    }
    return window
  }

  const accounts = ['a', 'b', 'c'].map((key) => ({
    id: `acc-${key}`,
    name: `Account ${key}`,
    platform: 'whatsapp',
    url: 'https://web.whatsapp.com/',
  }))
  const [first, second, third] = accounts

  const setUp = ({ withWindows = [] } = {}) => {
    const window = fakeWindow()
    const slept = []
    const manager = new ViewManager(window, 'UA', () => {}, {
      View: FakeView,
      hasChildWindows: (id) => withWindows.includes(id),
      onSlept: (id) => slept.push(id),
    })
    for (const account of accounts) manager.add(account)
    manager.show(first.id)
    return { window, manager, slept, viewOf: (id) => manager.views.get(id) }
  }

  test('the account in front is not put to sleep', () => {
    const { manager, viewOf } = setUp()
    const view = viewOf(first.id)
    expect(manager.sleep(first.id)).toEqual({ ok: false, reason: 'active' })
    expect(view.webContents.closes).toEqual([])
  })

  // A call under way on WhatsApp is a page playing sound, and closing it would hang up on somebody.
  test('an account playing sound is not put to sleep', () => {
    const { manager, viewOf } = setUp()
    viewOf(second.id).webContents.audible = true
    expect(manager.sleep(second.id)).toEqual({ ok: false, reason: 'audible' })
    expect(viewOf(second.id).webContents.closes).toEqual([])
  })

  // Closing the view closes the windows its page opened – a sign-in under way, a comment typed in
  // one – so an account with one open stays awake.
  test('an account with a window of its own open is not put to sleep', () => {
    const { manager, viewOf } = setUp({ withWindows: [second.id] })
    expect(manager.sleep(second.id)).toEqual({ ok: false, reason: 'child-window' })
    expect(viewOf(second.id).webContents.closes).toEqual([])
  })

  test('the reason is given before anything is tried, for the menu to show', () => {
    const { manager, viewOf } = setUp({ withWindows: [third.id] })
    viewOf(second.id).webContents.audible = true
    expect(manager.sleepRefusal(first.id)).toBe('active')
    expect(manager.sleepRefusal(second.id)).toBe('audible')
    expect(manager.sleepRefusal(third.id)).toBe('child-window')
    expect(manager.sleepRefusal('acc-missing')).toBe('missing')
  })

  // Closed first, detached only once Electron says the contents are gone. A page asked first may
  // refuse, and a view already taken off the window and forgotten would then be a renderer nobody
  // answers for.
  test('a sleep closes the page, asking it first, while the view is still in place', () => {
    const { window, manager, viewOf } = setUp()
    const view = viewOf(second.id)

    expect(manager.sleep(second.id)).toEqual({ ok: true })

    expect(view.webContents.closes).toEqual([{ options: { waitForBeforeUnload: true }, attached: true }])
    expect(window.contentView.children).toContain(view)
    expect(manager.views.get(second.id)).toBe(view)
    expect(manager.isFallingAsleep(second.id)).toBe(true)
    expect(manager.isAsleep(second.id)).toBe(false)
  })

  test('once the contents are gone the account is asleep, its view off the window and forgotten', () => {
    const { window, manager, slept, viewOf } = setUp()
    const view = viewOf(second.id)
    view.webContents.title = '(4) WhatsApp'
    manager.unreadByAccount()

    manager.sleep(second.id)
    view.webContents.finishClosing()

    expect(window.contentView.children).not.toContain(view)
    expect(manager.views.has(second.id)).toBe(false)
    expect(manager.countsUnread.has(second.id)).toBe(false)
    expect(manager.isFallingAsleep(second.id)).toBe(false)
    expect(manager.isAsleep(second.id)).toBe(true)
    expect(manager.asleepIds()).toEqual([second.id])
    expect(slept).toEqual([second.id])
    // Still known by name, for the menu and for waking.
    expect(manager.accounts.get(second.id)).toEqual(second)
  })

  // A count a sleeping account last showed is not a count any more: nothing updates it.
  test('a sleeping account has no count, rather than a count of nothing', () => {
    const { manager, viewOf } = setUp()
    viewOf(second.id).webContents.title = '(4) WhatsApp'
    manager.sleep(second.id)
    viewOf(second.id).webContents.finishClosing()
    expect(manager.unreadByAccount()).toEqual({ [first.id]: 0, [third.id]: 0 })
  })

  test('a page that refuses keeps its account awake and in place', () => {
    const { window, manager, slept, viewOf } = setUp()
    const view = viewOf(second.id)
    manager.sleep(second.id)

    manager.stayAwake(second.id)

    expect(manager.isFallingAsleep(second.id)).toBe(false)
    expect(manager.isAsleep(second.id)).toBe(false)
    expect(window.contentView.children).toContain(view)
    expect(manager.views.get(second.id)).toBe(view)
    // Destroyed later for another reason – the application quitting – it is not taken for asleep.
    view.webContents.finishClosing()
    expect(manager.isAsleep(second.id)).toBe(false)
    expect(slept).toEqual([])
  })

  test('an account already asleep, or on its way, is not put to sleep twice', () => {
    const { manager, viewOf } = setUp()
    manager.sleep(second.id)
    expect(manager.sleep(second.id)).toEqual({ ok: false, reason: 'asleep' })
    viewOf(second.id).webContents.finishClosing()
    expect(manager.sleep(second.id)).toEqual({ ok: false, reason: 'asleep' })
    expect(manager.sleep('acc-missing')).toEqual({ ok: false, reason: 'missing' })
  })

  test('a view on its way out is neither handed out again nor shown', () => {
    const { manager } = setUp()
    manager.sleep(second.id)
    expect(manager.add(second)).toBeNull()
    expect(manager.show(second.id)).toBe(false)
    expect(manager.activeId).toBe(first.id)
  })

  test('a sleeping account cannot be shown until it is woken', () => {
    const { manager, viewOf } = setUp()
    manager.sleep(second.id)
    viewOf(second.id).webContents.finishClosing()
    expect(manager.show(second.id)).toBe(false)
    expect(manager.activeId).toBe(first.id)
  })

  // Waking is a new view on the same partition, put back where the account stands among the awake
  // ones rather than at the end.
  test('waking makes a new view, in the place given', () => {
    const { window, manager, viewOf } = setUp()
    const old = viewOf(second.id)
    manager.sleep(second.id)
    old.webContents.finishClosing()

    const woken = manager.add(second, { index: 1 })

    expect(woken).not.toBe(old)
    expect(woken.options.webPreferences.partition).toBe('persist:acc-b')
    expect(window.contentView.children.indexOf(woken)).toBe(1)
    expect(manager.isAsleep(second.id)).toBe(false)
    expect(manager.asleepIds()).toEqual([])
    expect(manager.show(second.id)).toBe(true)
  })

  test('the waiting caller hears when a sleep has ended either way', async () => {
    const { manager, viewOf } = setUp()
    manager.sleep(second.id)
    const slept = manager.settled(second.id)
    viewOf(second.id).webContents.finishClosing()
    await expect(slept).resolves.toBe(true)

    manager.sleep(third.id)
    const refused = manager.settled(third.id)
    manager.stayAwake(third.id)
    await expect(refused).resolves.toBe(false)

    await expect(manager.settled(first.id)).resolves.toBe(false)
  })

  test('a view that goes once the window is gone does not reach for the window', () => {
    const { window, manager, viewOf } = setUp()
    manager.sleep(second.id)
    window.destroyed = true
    window.contentView.removeChildView = () => {
      throw new Error('Object has been destroyed')
    }
    expect(() => viewOf(second.id).webContents.finishClosing()).not.toThrow()
  })

  test('a sleeping account removed is forgotten, asleep or not', () => {
    const { manager, viewOf } = setUp()
    manager.sleep(second.id)
    viewOf(second.id).webContents.finishClosing()
    manager.remove(second.id)
    expect(manager.isAsleep(second.id)).toBe(false)
    expect(manager.accounts.has(second.id)).toBe(false)
  })

  test('an account edited while asleep is known as it is now', () => {
    const { manager, viewOf } = setUp()
    manager.sleep(second.id)
    viewOf(second.id).webContents.finishClosing()
    manager.update({ ...second, name: 'Renamed' })
    expect(manager.accounts.get(second.id).name).toBe('Renamed')
  })

  // The next account in the manager's own order is not the next on the rail once accounts have been
  // put to sleep and woken – and switching without the renderer left the rail on the old one.
  test('removing the account in front leaves the choice of the next to the rail', () => {
    const { manager } = setUp()
    manager.remove(first.id)
    expect(manager.activeId).toBeNull()
  })
})

describe('where a woken account goes among the views', () => {
  test('after the awake accounts that stand before it on the rail', () => {
    const order = ['acc-a', 'acc-b', 'acc-c', 'acc-d']
    expect(wakeIndex(order, 'acc-c', (id) => id === 'acc-a' || id === 'acc-d')).toBe(1)
    expect(wakeIndex(order, 'acc-a', () => true)).toBe(0)
    expect(wakeIndex(order, 'acc-d', (id) => id !== 'acc-d')).toBe(3)
  })

  test('an account the rail does not know goes to the end', () => {
    expect(wakeIndex(['acc-a', 'acc-b'], 'acc-x', () => true)).toBe(2)
  })
})
