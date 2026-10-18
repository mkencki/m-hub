import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { appWindowId, blankTheViews, clearStatusBar, loadInto, pressKey, servePages, webContentsIdFor } from './helpers.js'

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

// A local page into the window, over the live one it was opened for. Committed is not finished: the
// live page may still be fetching what it asked for, and its report of that cut short can fail the
// promise of this load or of the next one (runs 39069581881 and 39074653622) – hence loadInto.
const load = (contentsId, pathname) => loadInto(electronApp, contentsId, server.url(pathname))

// The address a webContents has committed. A step is waited for by this, not by the place in the
// history: getActiveIndex() moves the moment a step is asked for, before the page has landed, and a
// key sent on that answer meets a step still on its way (measured on CI, run 39071387442).
const committedUrl = (contentsId) =>
  electronApp.evaluate(({ webContents }, id) => webContents.fromId(id).getURL(), contentsId)

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
  await load(child.contentsId, '/one')
  await load(child.contentsId, '/two')
  return child
}

test('Alt+Left steps back in the window, and leaves the account alone', async () => {
  const child = await windowWithHistory()
  const accountBefore = await committedUrl(viewIds.two)

  await pressKey(electronApp, child.contentsId, 'Left', ['alt'])
  await expect.poll(() => committedUrl(child.contentsId)).toBe(server.url('/one'))

  await pressKey(electronApp, child.contentsId, 'Right', ['alt'])
  await expect.poll(() => committedUrl(child.contentsId)).toBe(server.url('/two'))
  expect(await committedUrl(viewIds.two)).toBe(accountBefore)
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
  await expect.poll(() => committedUrl(child.contentsId)).toBe(server.url('/one'))
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
  await load(child.contentsId, '/one')
  await expect.poll(() => menuItem(child.windowId, 'open-in-view')).toMatchObject({ enabled: false })
})

// A sign-in answers back to the window that opened it, and would never finish inside the view.
test('the menu of a sign-in window does not offer the account view', async () => {
  const child = await openWindowFrom(viewIds.three, 'https://accounts.google.com/o/oauth2/auth')
  await expect.poll(() => menuItem(child.windowId, 'open-in-view')).toMatchObject({ enabled: false })
})

// The load of the account view is recorded rather than done, so these tests do not depend on what
// the service answers, and the view reports what Electron would report of it: whether the page got
// there is read from those reports, not from the promise loadURL returns (see landing.js).
const reportLoads = (viewId, report) =>
  electronApp.evaluate(
    ({ webContents }, { id, report }) => {
      globalThis.__loads = []
      const contents = webContents.fromId(id)
      const event = { preventDefault() {} }
      contents.loadURL = (address) => {
        globalThis.__loads.push(address)
        if (report === 'commit') {
          contents.emit('did-navigate', event, address, 200, 'OK')
          return Promise.resolve()
        }
        if (report === 'refusal') {
          // How Electron reports a page that refuses to be left: an abort of the address asked for.
          contents.emit('did-fail-load', event, -3, 'ERR_ABORTED', address, true)
          return Promise.reject(Object.assign(new Error(`ERR_ABORTED (-3) loading '${address}'`), { errno: -3 }))
        }
        // 'left behind': the page being left reports its unfinished load cut short, at once, which
        // fails the promise; the new page commits a moment later all the same.
        const left = contents.getURL()
        contents.emit('did-fail-load', event, -3, 'ERR_ABORTED', left, true)
        setTimeout(() => contents.emit('did-navigate', event, address, 200, 'OK'), 300)
        return Promise.reject(Object.assign(new Error(`ERR_ABORTED (-3) loading '${left}'`), { errno: -3 }))
      }
    },
    { id: viewId, report },
  )

// The page moves into the account it came from, the rail goes to that account, and the window,
// whose page is now in the view, closes.
test('Open in the account view moves the page there and closes the window', async () => {
  const child = await openWindowFrom(viewIds.two, 'https://www.facebook.com/login')
  await expect.poll(() => menuItem(child.windowId, 'open-in-view')).toMatchObject({ enabled: true })
  await reportLoads(viewIds.two, 'commit')
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
  await reportLoads(viewIds.two, 'commit')
  await electronApp.evaluate(({ BrowserWindow }, childId) => {
    const window = BrowserWindow.fromId(childId)
    window.close = () => window.webContents.emit('will-prevent-unload', { preventDefault() {} })
  }, child.windowId)

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
  await reportLoads(viewIds.two, 'refusal')

  await clickMenuItem(child.windowId, 'open-in-view')

  await expect
    .poll(() => electronApp.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)?.isVisible() ?? null, child.windowId))
    .toBe(true)
  expect(await windowCount()).toBe(2)
})

// The page being left can report its own unfinished load as aborted – the account view's live page
// still fetching what it asked for – and loadURL's promise fails on that report (measured on CI,
// run 39074653622). The page the window held is in the view all the same, so the window closes
// rather than coming back beside it.
test('the account page reporting its own load cut short does not bring the window back', async () => {
  const child = await openWindowFrom(viewIds.two, 'https://www.facebook.com/login')
  await expect.poll(() => menuItem(child.windowId, 'open-in-view')).toMatchObject({ enabled: true })
  await reportLoads(viewIds.two, 'left behind')

  await clickMenuItem(child.windowId, 'open-in-view')

  await expect.poll(windowCount).toBe(1)
})
