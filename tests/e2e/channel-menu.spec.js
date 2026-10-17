import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { appWindowId, blankTheViews, captureMenus, clearStatusBar, clickMenuItem, lastMenu, webContentsIdFor } from './helpers.js'

// The menu a channel opens on a right click: reload, hard reload or restart THAT account, while
// the operator goes on looking at another. A native menu cannot be driven from a test – it runs a
// loop of its own on the desktop of whoever started the run – so captureMenus catches it on its
// way out and the item is clicked from the main process. Everything either side of that is real:
// the right click on the rail, and what the item does to the account.

// Geometry from src/main/main.js, as in rail.spec.js: the left edge of the account view is the
// simplest proof of how much room the rail takes.
const COLLAPSED = 48
const EXPANDED = 162
const MARGIN = 10
// A point in the account well, well clear of the rail.
const AWAY = { x: 600, y: 300 }

let dataDir
let electronApp
let page
let windowId
const viewIds = {}

test.beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'mhub-channel-menu-'))
  await writeFile(
    path.join(dataDir, 'accounts.json'),
    JSON.stringify({
      version: 2,
      accounts: [
        { id: 'acc-one', name: 'Account one', platform: 'whatsapp', url: 'https://web.whatsapp.com/', color: '#2f7d5b' },
        // Messenger, because its sign-in is a window the page opens – the one kind of window an
        // account can have of its own, and the one a restart may take down.
        { id: 'acc-two', name: 'Account two', platform: 'messenger', url: 'https://www.messenger.com/', color: '#6586ec' },
      ],
    }),
    'utf8',
  )
  electronApp = await electron.launch({ args: ['.', `--user-data-dir=${dataDir}`] })
  page = await electronApp.firstWindow()
  await page.waitForSelector('body[data-ready="1"]')
  await expect(page.locator('.channel')).toHaveCount(2)
  windowId = await appWindowId(electronApp)
  for (const [key, accountId] of [
    ['one', 'acc-one'],
    ['two', 'acc-two'],
  ]) {
    await expect.poll(() => webContentsIdFor(electronApp, accountId)).not.toBeNull()
    viewIds[key] = await webContentsIdFor(electronApp, accountId)
  }

  // None of this is about the service pages: about:blank gives each view a document of its own
  // to lose when it reloads, and a load that certainly finishes – a view still on its first load
  // routes no focus at all, which is half of what is tested here. Blanked the careful way – see
  // blankTheViews.
  await blankTheViews(electronApp)
  const blankAndSettled = () =>
    electronApp.evaluate(({ BrowserWindow }, id) => {
      const views = BrowserWindow.fromId(id).contentView.children
      return views.every((v) => v.webContents.getURL() === 'about:blank' && !v.webContents.isLoading())
    }, windowId)
  await expect.poll(blankAndSettled).toBe(true)
  await clearStatusBar(page)
  await captureMenus(electronApp)
})

test.afterEach(async () => {
  // The bounded quit of downloads.spec.js, for the reason given there.
  await electronApp.evaluate(({ app }) => app.quit()).catch(() => {})
  const closing = electronApp.close().then(() => 'closed', () => 'closed')
  const exit = await Promise.race([closing, new Promise((over) => setTimeout(() => over('stuck'), 10000))])
  if (exit === 'stuck') electronApp.process().kill()

  const cleanup = rm(dataDir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
  await Promise.race([cleanup, new Promise((done) => setTimeout(done, 3000))])
})

const inView = (id, script) =>
  electronApp.evaluate(({ webContents }, { id, script }) => webContents.fromId(id).executeJavaScript(script), {
    id,
    script,
  })

const mark = (id) => inView(id, 'window.__mark = "here", 1')
const markSurvives = (id) => inView(id, 'window.__mark === "here"').catch(() => false)

const selectedChannel = () =>
  page.locator('.channel[aria-selected="true"]').getAttribute('data-account-id')

const viewLeftEdge = () =>
  electronApp.evaluate(({ BrowserWindow }, id) => {
    const w = BrowserWindow.fromId(id)
    return w.contentView.children.find((v) => v.getBounds().height > 0)?.getBounds().x ?? null
  }, windowId)

// Opens an account's menu the way the rail does, without a pointer: the handler pops the menu up
// before it answers, so by the time this returns the menu has been caught.
const menuFor = async (accountId) => {
  await page.evaluate((id) => window.mHub.openChannelMenu(id), accountId)
  return lastMenu(electronApp)
}

const labelOf = (items, id) => items.find((item) => item.id === id)?.label

test('a right click on a channel opens that account menu, named for it', async () => {
  await page.locator('.channel[data-account-id="acc-two"]').click({ button: 'right' })

  await expect.poll(() => lastMenu(electronApp)).not.toBeNull()
  const items = await lastMenu(electronApp)
  expect(items[0]).toMatchObject({ id: 'account', label: 'Account two', enabled: false })
  expect(items.map((item) => item.id)).toEqual(expect.arrayContaining(['reload', 'hard-reload', 'restart']))
})

test('reloading from the menu reloads that account and leaves the one in front where it is', async () => {
  expect(await selectedChannel()).toBe('acc-one')
  await mark(viewIds.one)
  await mark(viewIds.two)

  await page.locator('.channel[data-account-id="acc-two"]').click({ button: 'right' })
  await expect.poll(() => lastMenu(electronApp)).not.toBeNull()
  await clickMenuItem(electronApp, 'reload')

  await expect.poll(() => markSurvives(viewIds.two)).toBe(false)
  expect(await markSurvives(viewIds.one)).toBe(true)
  expect(await selectedChannel()).toBe('acc-one')
})

// The two that cannot be told apart from an ordinary reload by looking at the page, so the main
// process is asked which call reached the account. The method is replaced rather than watched:
// ending a renderer for real cuts Playwright's connection to it – see recovery.spec.js.
for (const [command, method] of [
  ['hard-reload', 'reloadIgnoringCache'],
  ['restart', 'forcefullyCrashRenderer'],
]) {
  test(`${command} from the menu reaches the page of that account`, async () => {
    await electronApp.evaluate(
      ({ webContents }, { id, method }) => {
        globalThis.__calls = []
        webContents.fromId(id)[method] = () => globalThis.__calls.push(method)
      },
      { id: viewIds.two, method },
    )

    await menuFor('acc-two')
    await clickMenuItem(electronApp, command)

    expect(await electronApp.evaluate(() => globalThis.__calls)).toEqual([method])
  })
}

// A view takes the system's focus while it loads, and the focus listener takes a view taking
// focus for a clicked notification. An account reloaded in the background must not pull the
// rail over to itself in the middle of what the operator was doing.
test('a page taking focus while it reloads does not switch the channel', async () => {
  await page.evaluate(() => {
    window.__switches = []
    window.mHub.onSelectAccountId((id) => window.__switches.push(id))
  })
  await menuFor('acc-two')

  // The click and the focus in one turn of the main process's loop: the reload cannot have
  // finished in between, so the focus lands squarely inside it.
  await electronApp.evaluate(({ webContents }, id) => {
    const last = globalThis.__capturedMenus.at(-1)
    const window = last.options.window
    last.menu.getMenuItemById('reload').click(undefined, window, window.webContents)
    last.options.callback?.()
    webContents.fromId(id).emit('focus')
  }, viewIds.two)
  await page.waitForTimeout(400)

  expect(await page.evaluate(() => window.__switches)).toEqual([])
  expect(await selectedChannel()).toBe('acc-one')

  // The control: once the reload has finished, the same focus is a clicked notification again
  // and does switch – so the silence above was the rule at work, not a listener that never ran.
  await expect
    .poll(() => electronApp.evaluate(({ webContents }, id) => webContents.fromId(id).isLoading(), viewIds.two))
    .toBe(false)
  await electronApp.evaluate(({ webContents }, id) => webContents.fromId(id).emit('focus'), viewIds.two)

  await expect.poll(selectedChannel).toBe('acc-two')
})

// The pointer moving onto a native menu reads, to the page beneath it, as the pointer leaving
// the rail. Acted on, the rail would fold away under the menu. Once the menu is gone the rail has
// to follow the pointer again – here it is out in the account well, so the rail closes.
test('the rail stays open while the menu is, and follows the pointer once it closes', async () => {
  // The physical pointer is put where the test needs it by moving the WINDOW under it – see
  // parkPointer in rail.spec.js. Nothing moves the mouse.
  await electronApp.evaluate(
    ({ BrowserWindow, screen }, { id, x, y }) => {
      const window = BrowserWindow.fromId(id)
      const cursor = screen.getCursorScreenPoint()
      const content = window.getContentBounds()
      window.setContentBounds({ ...content, x: Math.round(cursor.x - x), y: Math.round(cursor.y - y) })
    },
    { id: windowId, ...AWAY },
  )
  await page.evaluate(() => window.mHub.hoverRail(true))
  await expect.poll(viewLeftEdge).toBe(EXPANDED + MARGIN)

  await menuFor('acc-two')
  await page.evaluate(() => window.mHub.hoverRail(false, false))
  expect(await viewLeftEdge()).toBe(EXPANDED + MARGIN)

  // Closed without choosing anything, as Esc or a click elsewhere closes it.
  await electronApp.evaluate(() => globalThis.__capturedMenus.at(-1).options.callback?.())

  await expect.poll(viewLeftEdge).toBe(COLLAPSED + MARGIN)
})

// A restart ends the renderer, and a window the page opened may share it – a sign-in half done
// would go with it. The menu says so while the window is open, and stops saying so once it is not.
test('the restart warns while the account has a window of its own open', async () => {
  const quiet = labelOf(await menuFor('acc-two'), 'restart')

  await inView(viewIds.two, 'window.open("https://www.messenger.com/login"), 1')
  await expect.poll(() => electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(2)

  const warned = labelOf(await menuFor('acc-two'), 'restart')
  expect(warned).not.toBe(quiet)
  // The other account has no window open, so its menu has nothing to warn about.
  expect(labelOf(await menuFor('acc-one'), 'restart')).toBe(quiet)

  await electronApp.evaluate(({ BrowserWindow }, id) => {
    for (const window of BrowserWindow.getAllWindows()) if (window.id !== id) window.destroy()
  }, windowId)
  await expect.poll(() => electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1)

  expect(labelOf(await menuFor('acc-two'), 'restart')).toBe(quiet)
})

// Renaming keeps the view and its sign-in, so the view is never made again – and the menu has to
// learn the new name some other way, or it labels itself with one the rail no longer shows.
test('the menu names an account renamed while the app runs by its new name', async () => {
  const result = await page.evaluate(() => window.mHub.updateAccount('acc-two', { name: 'Renamed account' }))
  expect(result.ok).toBe(true)

  const items = await menuFor('acc-two')
  expect(items[0].label).toBe('Renamed account')
})
