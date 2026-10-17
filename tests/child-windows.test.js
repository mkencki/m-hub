import { describe, test, expect } from 'vitest'
import { childWindowMenuTemplate, runInWindow } from '../src/main/child-windows.js'
import { PLATFORMS } from '../src/main/accounts.js'
import { t } from '../src/shared/i18n.js'

const tr = (key, params) => t('en', key, params)
const facebook = PLATFORMS.facebook
const linkedin = PLATFORMS.linkedin

const menuFor = (overrides = {}) =>
  childWindowMenuTemplate({
    platform: facebook,
    url: 'https://www.facebook.com/some.page/posts/1',
    canGoBack: false,
    canGoForward: false,
    tr,
    ...overrides,
  })

// The items under the window's one menu, by id.
const itemsOf = (template) => template[0].submenu
const item = (template, id) => itemsOf(template).find((entry) => entry.id === id)

describe('the menu of a window a page opened', () => {
  test('offers back, forward, reload and the way into the account view', () => {
    const ids = itemsOf(menuFor()).map((entry) => entry.id ?? entry.type)
    expect(ids).toEqual(['back', 'forward', 'reload', 'separator', 'open-in-view'])
  })

  test('back and forward are offered only where the window can go', () => {
    expect(item(menuFor(), 'back').enabled).toBe(false)
    expect(item(menuFor(), 'forward').enabled).toBe(false)
    expect(item(menuFor({ canGoBack: true }), 'back').enabled).toBe(true)
    expect(item(menuFor({ canGoForward: true }), 'forward').enabled).toBe(true)
  })

  // A page of the service itself – a post opened with a middle click – belongs in the account
  // view, where it gets the account's back button.
  test('a page of the service can be moved into the account view', () => {
    expect(item(menuFor(), 'open-in-view').enabled).toBe(true)
  })

  // A sign-in answers back to the window that opened it. Moved into the account view, it would
  // lose whoever it answers to, and the sign-in would never finish.
  test('a sign-in page cannot be moved into the account view', () => {
    const signIn = menuFor({ platform: linkedin, url: 'https://accounts.google.com/o/oauth2/auth' })
    expect(item(signIn, 'open-in-view').enabled).toBe(false)
  })

  // The view only ever holds the service's own pages – anything else goes to the system browser.
  test('nor can a page of somebody else, a link shim, or something that is no address', () => {
    for (const url of ['https://example.org/article', 'https://l.facebook.com/l.php?u=x', 'about:blank', 'not an address']) {
      expect(item(menuFor({ url }), 'open-in-view').enabled).toBe(false)
    }
  })

  // The keys are taken in before-input-event, where the window's other shortcuts are. A menu that
  // registered them as well would answer the same key a second time.
  test('names the keys without taking them', () => {
    const withKeys = itemsOf(menuFor()).filter((entry) => entry.accelerator)
    expect(withKeys.map((entry) => entry.accelerator)).toEqual(['Alt+Left', 'Alt+Right', 'F5'])
    for (const entry of withKeys) expect(entry.registerAccelerator).toBe(false)
  })

  // The status bar and the channel menu call a reload by one word. A third word for the same act
  // would read as a different act.
  test('calls a reload by the name the rest of the application uses', () => {
    for (const language of ['en', 'pl']) {
      const template = menuFor({ tr: (key) => t(language, key) })
      expect(item(template, 'reload').label).toBe(t(language, 'reloadAccount'))
    }
  })

  test('labels its items in the interface language', () => {
    const template = menuFor({ tr: (key) => t('pl', key) })
    expect(item(template, 'back').label).toBe('Wstecz')
    expect(item(template, 'open-in-view').label).toBe('Otwórz w widoku konta')
  })
})

describe('what a key or a menu item does in such a window', () => {
  const recordingContents = ({ back = false, forward = false } = {}) => {
    const calls = []
    return {
      calls,
      navigationHistory: {
        canGoBack: () => back,
        canGoForward: () => forward,
        goBack: () => calls.push('goBack'),
        goForward: () => calls.push('goForward'),
      },
      reload: () => calls.push('reload'),
      reloadIgnoringCache: () => calls.push('reloadIgnoringCache'),
      toggleDevTools: () => calls.push('toggleDevTools'),
    }
  }

  test('steps through the window history, one step at a time', () => {
    const contents = recordingContents({ back: true, forward: true })
    expect(runInWindow(contents, 'back')).toBe(true)
    expect(runInWindow(contents, 'forward')).toBe(true)
    expect(contents.calls).toEqual(['goBack', 'goForward'])
  })

  test('takes no step where there is nowhere to go', () => {
    const contents = recordingContents()
    expect(runInWindow(contents, 'back')).toBe(false)
    expect(runInWindow(contents, 'forward')).toBe(false)
    expect(contents.calls).toEqual([])
  })

  test('reloads the window, past the cache when asked, and opens its developer tools', () => {
    const contents = recordingContents()
    runInWindow(contents, 'reload')
    runInWindow(contents, 'hard-reload')
    runInWindow(contents, 'devtools')
    expect(contents.calls).toEqual(['reload', 'reloadIgnoringCache', 'toggleDevTools'])
  })

  test('does nothing it was not made for', () => {
    const contents = recordingContents({ back: true })
    expect(runInWindow(contents, 'macros')).toBe(false)
    expect(runInWindow(contents, { select: 0 })).toBe(false)
    expect(contents.calls).toEqual([])
  })
})
