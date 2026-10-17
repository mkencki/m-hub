import { describe, test, expect } from 'vitest'
import { unreadFromTitle, cleanUserAgent, createView, ViewManager } from '../src/main/views.js'

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
  // notice messages arriving must not put its accounts to sleep to save a little battery.
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
