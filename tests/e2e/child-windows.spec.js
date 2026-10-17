import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { appWindowId, blankTheViews, clearStatusBar, pressKey, servePages, webContentsIdFor } from './helpers.js'

// A window a page opened for itself – a sign-in, or a post opened with a middle click – stays a
// window, and gets what a small browser needs: Alt and the arrows, F5, and a menu that can move a
// page of the service into the account view. See child-windows.js for why it is not moved there
// by itself.

const PAGE = (title) => `<!doctype html><title>${title}</title><p>${title}</p>`

let dataDir
let electronApp
let page
let server
let windowId
const viewIds = {}

test.beforeEach(async () => {
  server = await servePages({ '/one': PAGE('one'), '/two': PAGE('two') })
  dataDir = await mkdtemp(path.join(tmpdir(), 'mhub-child-windows-'))
  await writeFile(
    path.join(dataDir, 'accounts.json'),
    JSON.stringify({
      version: 2,
      accounts: [
        { id: 'acc-one', name: 'Account one', platform: 'whatsapp', url: 'https://web.whatsapp.com/', color: '#2f7d5b' },
        { id: 'acc-two', name: 'Account two', platform: 'facebook', url: 'https://www.facebook.com/', color: '#6586ec' },
        // LinkedIn declares where its sign-ins happen, and a window on one of those hosts is the
        // case the menu has to refuse.
        { id: 'acc-three', name: 'Account three', platform: 'linkedin', url: 'https://www.linkedin.com/feed/', color: '#c9a227' },
      ],
    }),
    'utf8',
  )
  electronApp = await electron.launch({ args: ['.', `--user-data-dir=${dataDir}`] })
  page = await electronApp.firstWindow()
  await page.waitForSelector('body[data-ready="1"]')
  await expect(page.locator('.channel')).toHaveCount(3)
  windowId = await appWindowId(electronApp)
  for (const [key, accountId] of [
    ['one', 'acc-one'],
    ['two', 'acc-two'],
    ['three', 'acc-three'],
  ]) {
    await expect.poll(() => webContentsIdFor(electronApp, accountId)).not.toBeNull()
    viewIds[key] = await webContentsIdFor(electronApp, accountId)
  }
  await blankTheViews(electronApp)
  await clearStatusBar(page)

  // The menu a window is given, caught on its way in so a test can read it and click it. The menu
  // is still set – the window's own menu bar is part of what is tested.
  await electronApp.evaluate(({ BrowserWindow }) => {
    globalThis.__windowMenus = new Map()
    const setMenu = BrowserWindow.prototype.setMenu
    BrowserWindow.prototype.setMenu = function (menu) {
      globalThis.__windowMenus.set(this.id, menu)
      return setMenu.call(this, menu)
    }
  })
})

test.afterEach(async () => {
  // The bounded quit of downloads.spec.js, for the reason given there.
  await electronApp.evaluate(({ app }) => app.quit()).catch(() => {})
  const closing = electronApp.close().then(() => 'closed', () => 'closed')
  const exit = await Promise.race([closing, new Promise((over) => setTimeout(() => over('stuck'), 10000))])
  if (exit === 'stuck') electronApp.process().kill()

  await server.close()
  const cleanup = rm(dataDir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
  await Promise.race([cleanup, new Promise((done) => setTimeout(done, 3000))])
})

const inContents = (id, script) =>
  electronApp.evaluate(({ webContents }, { id, script }) => webContents.fromId(id).executeJavaScript(script), {
    id,
    script,
  })

// Opens a window from an account page the way the page itself would, and answers with the window's
// id and the id of its webContents. A host of the service, or one of its sign-in hosts, because
// anything else is sent to the system browser rather than opened.
//
// Answers only once the window has committed its first page – the real one, or the error page that
// stands in for it offline. A load started over a navigation still on its way is the race
// blankTheViews describes: the one already handed on to commit lands last and wins.
async function openWindowFrom(viewId, address) {
  await inContents(viewId, `window.open(${JSON.stringify(address)}), 1`)
  await expect
    .poll(() => electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length))
    .toBe(2)
  const child = await electronApp.evaluate(({ BrowserWindow }, appId) => {
    const window = BrowserWindow.getAllWindows().find((candidate) => candidate.id !== appId)
    return { windowId: window.id, contentsId: window.webContents.id }
  }, windowId)
  await expect
    .poll(
      () => electronApp.evaluate(({ webContents }, id) => webContents.fromId(id).getURL(), child.contentsId),
      { timeout: 20000 },
    )
    .toMatch(/^https:\/\//)
  return child
}

const load = (contentsId, pathname) =>
  electronApp.evaluate(({ webContents }, { id, address }) => webContents.fromId(id).loadURL(address), {
    id: contentsId,
    address: server.url(pathname),
  })

// The first local page over the live one the window was opened for. Committed is not finished: the
// live page may still be fetching what it asked for, and a load started over it stops that – which
// Electron then reports as the NEW load failing, "(-3) loading 'https://www.facebook.com/login'"
// (measured on CI, run 39069581881). The answer that counts is where the window ends up.
async function loadOverLivePage(contentsId, pathname) {
  await load(contentsId, pathname).catch(() => {})
  await expect
    .poll(() => electronApp.evaluate(({ webContents }, id) => webContents.fromId(id).getURL(), contentsId))
    .toBe(server.url(pathname))
}

const activeIndex = (contentsId) =>
  electronApp.evaluate(({ webContents }, id) => webContents.fromId(id).navigationHistory.getActiveIndex(), contentsId)

// One item of the menu last given to that window, as plain values, or null.
const menuItem = (childId, itemId) =>
  electronApp.evaluate(
    (_electron, { childId, itemId }) => {
      const item = globalThis.__windowMenus.get(childId)?.getMenuItemById(itemId)
      return item ? { label: item.label, enabled: item.enabled } : null
    },
    { childId, itemId },
  )

const clickMenuItem = (childId, itemId) =>
  electronApp.evaluate(
    ({ BrowserWindow }, { childId, itemId }) => {
      const child = BrowserWindow.fromId(childId)
      globalThis.__windowMenus.get(childId).getMenuItemById(itemId).click(undefined, child, child.webContents)
    },
    { childId, itemId },
  )

const windowCount = () => electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)

// A window on a local history of two pages, standing on the second.
async function windowWithHistory() {
  const child = await openWindowFrom(viewIds.two, 'https://www.facebook.com/login')
  await loadOverLivePage(child.contentsId, '/one')
  await load(child.contentsId, '/two')
  await expect.poll(() => activeIndex(child.contentsId)).toBeGreaterThan(0)
  return child
}

test('Alt+Left steps back in the window, and leaves the account alone', async () => {
  const child = await windowWithHistory()
  const before = await activeIndex(child.contentsId)
  const accountBefore = await activeIndex(viewIds.two)

  await pressKey(electronApp, child.contentsId, 'Left', ['alt'])
  await expect.poll(() => activeIndex(child.contentsId)).toBe(before - 1)

  await pressKey(electronApp, child.contentsId, 'Right', ['alt'])
  await expect.poll(() => activeIndex(child.contentsId)).toBe(before)
  expect(await activeIndex(viewIds.two)).toBe(accountBefore)
})

test('F5 reloads the window, not the account', async () => {
  const child = await windowWithHistory()
  await inContents(child.contentsId, 'window.__mark = "here", 1')
  await inContents(viewIds.two, 'window.__mark = "here", 1')

  await pressKey(electronApp, child.contentsId, 'F5')

  await expect.poll(() => inContents(child.contentsId, 'window.__mark === "here"').catch(() => false)).toBe(false)
  expect(await inContents(viewIds.two, 'window.__mark === "here"')).toBe(true)
})

// The window's menu bar stays hidden until Alt is pressed and released on its own. Alt+Left is not
// Alt on its own, and must not bring the bar out on every step back – while Alt alone still must,
// or the menu could not be reached at all. Every key goes in as a real one arrives.
test('Alt+Left leaves the menu bar hidden, and Alt on its own shows it', async () => {
  const child = await windowWithHistory()
  const before = await activeIndex(child.contentsId)
  const send = (events) =>
    electronApp.evaluate(
      ({ webContents }, { id, events }) => {
        for (const event of events) webContents.fromId(id).sendInputEvent(event)
      },
      { id: child.contentsId, events },
    )
  const menuBarShown = () =>
    electronApp.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).isMenuBarVisible(), child.windowId)

  expect(await menuBarShown()).toBe(false)

  await send([
    { type: 'keyDown', keyCode: 'Alt', modifiers: ['alt'] },
    { type: 'keyDown', keyCode: 'Left', modifiers: ['alt'] },
    { type: 'keyUp', keyCode: 'Left', modifiers: ['alt'] },
    { type: 'keyUp', keyCode: 'Alt', modifiers: [] },
  ])
  await expect.poll(() => activeIndex(child.contentsId)).toBe(before - 1)
  await page.waitForTimeout(1000)
  expect(await menuBarShown()).toBe(false)

  await send([
    { type: 'keyDown', keyCode: 'Alt', modifiers: ['alt'] },
    { type: 'keyUp', keyCode: 'Alt', modifiers: [] },
  ])
  await expect.poll(menuBarShown).toBe(true)
})

test('the menu offers the account view for a page of the service, and only for one', async () => {
  const child = await openWindowFrom(viewIds.two, 'https://www.facebook.com/login')
  await expect.poll(() => menuItem(child.windowId, 'open-in-view')).toMatchObject({ enabled: true })

  // A page somewhere else is the system browser's business, not the account's.
  await loadOverLivePage(child.contentsId, '/one')
  await expect.poll(() => menuItem(child.windowId, 'open-in-view')).toMatchObject({ enabled: false })
})

// A sign-in answers back to the window that opened it, and would never finish inside the view.
test('the menu of a sign-in window does not offer the account view', async () => {
  const child = await openWindowFrom(viewIds.three, 'https://accounts.google.com/o/oauth2/auth')
  await expect.poll(() => menuItem(child.windowId, 'open-in-view')).toMatchObject({ enabled: false })
})

// The page moves into the account it came from, the rail goes to that account, and the window,
// whose page is now in the view, closes. The load is recorded rather than done, so the test does
// not depend on what the service answers.
test('Open in the account view moves the page there and closes the window', async () => {
  const child = await openWindowFrom(viewIds.two, 'https://www.facebook.com/login')
  await expect.poll(() => menuItem(child.windowId, 'open-in-view')).toMatchObject({ enabled: true })
  await electronApp.evaluate(({ webContents }, id) => {
    globalThis.__loads = []
    webContents.fromId(id).loadURL = (address) => {
      globalThis.__loads.push(address)
      return Promise.resolve()
    }
  }, viewIds.two)
  await clickMenuItem(child.windowId, 'open-in-view')

  // The address the window stood on – a page of the service. Not compared letter for letter: the
  // live sign-in page may rewrite its own address at any moment, which is no concern of this test.
  await expect.poll(() => electronApp.evaluate(() => globalThis.__loads.length)).toBe(1)
  expect((await electronApp.evaluate(() => globalThis.__loads))[0]).toMatch(/^https:\/\/([a-z0-9-]+\.)*facebook\.com\//)
  await expect.poll(windowCount).toBe(1)
  await expect(page.locator('.channel[data-account-id="acc-two"]')).toHaveAttribute('aria-selected', 'true')
})

// The window's own page can refuse to close – a comment typed in it – as silently as an account
// page refuses a load. The window had already stepped out of sight for the move, and left hidden
// it would hold the comment where nobody could ever reach it again. The close is replaced by the
// refusal Electron reports, for the reason reload-keys.spec.js gives for not using a real one.
test('a window whose page refuses to close comes back after the move', async () => {
  const child = await openWindowFrom(viewIds.two, 'https://www.facebook.com/login')
  await expect.poll(() => menuItem(child.windowId, 'open-in-view')).toMatchObject({ enabled: true })
  await electronApp.evaluate(
    ({ BrowserWindow, webContents }, { viewId, childId }) => {
      webContents.fromId(viewId).loadURL = () => Promise.resolve()
      const window = BrowserWindow.fromId(childId)
      window.close = () => window.webContents.emit('will-prevent-unload', { preventDefault() {} })
    },
    { viewId: viewIds.two, childId: child.windowId },
  )

  await clickMenuItem(child.windowId, 'open-in-view')

  await expect
    .poll(() => electronApp.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)?.isVisible() ?? null, child.windowId))
    .toBe(true)
})

// The account page can refuse to be left – a draft in its composer. The page in the window must
// not be lost to a move that never happened: the window comes back.
test('a move the account page refuses leaves the window open', async () => {
  const child = await openWindowFrom(viewIds.two, 'https://www.facebook.com/login')
  await expect.poll(() => menuItem(child.windowId, 'open-in-view')).toMatchObject({ enabled: true })
  await electronApp.evaluate(({ webContents }, id) => {
    webContents.fromId(id).loadURL = () => Promise.reject(Object.assign(new Error('ERR_ABORTED (-3)'), { errno: -3, code: 'ERR_ABORTED' }))
  }, viewIds.two)

  await clickMenuItem(child.windowId, 'open-in-view')

  await expect
    .poll(() => electronApp.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)?.isVisible() ?? null, child.windowId))
    .toBe(true)
  expect(await windowCount()).toBe(2)
})
