import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { appWindowId, blankTheViews, clearStatusBar, pressKey, webContentsIdFor } from './helpers.js'

// F5 and its relatives, and what happens when a page refuses to be left. Every key here goes in
// through sendInputEvent, the path a real key takes: Playwright's keyboard never reaches
// before-input-event, where these keys are handled, so a test pressing them that way would pass
// whether they worked or not.

let dataDir
let electronApp
let page
let viewId
let windowContentsId

test.beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'mhub-reload-'))
  await writeFile(
    path.join(dataDir, 'accounts.json'),
    JSON.stringify({
      version: 2,
      accounts: [
        { id: 'acc-one', name: 'Account one', platform: 'whatsapp', url: 'https://web.whatsapp.com/', color: '#2f7d5b' },
      ],
    }),
    'utf8',
  )
  electronApp = await electron.launch({ args: ['.', `--user-data-dir=${dataDir}`] })
  page = await electronApp.firstWindow()
  await page.waitForSelector('body[data-ready="1"]')
  const windowId = await appWindowId(electronApp)
  windowContentsId = await electronApp.evaluate(
    ({ BrowserWindow }, id) => BrowserWindow.fromId(id).webContents.id,
    windowId,
  )
  await expect.poll(() => webContentsIdFor(electronApp, 'acc-one')).not.toBeNull()
  viewId = await webContentsIdFor(electronApp, 'acc-one')

  // None of this is about the service page: about:blank gives the view a document of its own to
  // lose when it reloads. Blanked the careful way – see blankTheViews.
  await blankTheViews(electronApp)
  await clearStatusBar(page)
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

const inView = (script) =>
  electronApp.evaluate(({ webContents }, { id, script }) => webContents.fromId(id).executeJavaScript(script), {
    id: viewId,
    script,
  })

const mark = () => inView('window.__mark = "here", 1')
const markSurvives = () => inView('window.__mark === "here"').catch(() => false)

// Whether the main process has the account view shown. A dialog hides the views and closing it
// shows them again, but both go through the renderer's queued close event and an IPC call, so
// the dialog can look open or closed a moment before the views have followed. A key sent in that
// moment answers a different question from the one the test asks.
const viewShown = () =>
  electronApp.evaluate(({ BrowserWindow }, id) => {
    for (const window of BrowserWindow.getAllWindows()) {
      const view = window.contentView.children.find((child) => child.webContents?.id === id)
      if (view) return view.getVisible()
    }
    return null
  }, viewId)

// A page refusing to be left, as Electron reports it. A real beforeunload cannot stand in for
// this here: Playwright is attached to the account view over the DevTools protocol, takes the
// refusal for a dialog of its own and fails the test trying to dismiss a dialog Electron never
// showed – measured on CI, run 38990782830, "Page.handleJavaScriptDialog: No dialog is showing".
// Outside a debugger there is no such path. So the report is delivered directly, as
// recovery.spec.js delivers a crash, and the answer is whether the application overrode the page.
const refuseToUnload = () =>
  electronApp.evaluate(({ webContents }, id) => {
    let overridden = false
    webContents.fromId(id).emit('will-prevent-unload', {
      preventDefault: () => {
        overridden = true
      },
    })
    return overridden
  }, viewId)

// Counts reload() on the account view instead of doing it, so the page – and the refusal it is
// pretending to make – stays where it is.
const countReloads = () =>
  electronApp.evaluate(({ webContents }, id) => {
    globalThis.__reloads = 0
    webContents.fromId(id).reload = () => {
      globalThis.__reloads += 1
    }
  }, viewId)
const reloads = () => electronApp.evaluate(() => globalThis.__reloads)

test('F5 in the account view reloads the account', async () => {
  await mark()
  await pressKey(electronApp, viewId, 'F5')
  await expect.poll(markSurvives).toBe(false)
})

// The same key inside the application's own window would tear down the interface, the rail
// and the status bar, and take the account views with it.
test('F5 in the app window reloads the account, not the interface', async () => {
  await mark()
  await page.evaluate(() => {
    window.__interfaceMark = 'here'
  })

  await pressKey(electronApp, windowContentsId, 'F5')
  await expect.poll(markSurvives).toBe(false)

  expect(await page.evaluate(() => window.__interfaceMark)).toBe('here')
})

test('Ctrl+F5 reloads past the cache', async () => {
  await electronApp.evaluate(({ webContents }, id) => {
    const contents = webContents.fromId(id)
    const original = contents.reloadIgnoringCache.bind(contents)
    globalThis.__hardReloads = 0
    contents.reloadIgnoringCache = () => {
      globalThis.__hardReloads += 1
      return original()
    }
  }, viewId)

  await pressKey(electronApp, viewId, 'F5', ['control'])

  await expect.poll(() => electronApp.evaluate(() => globalThis.__hardReloads)).toBe(1)
})

// A hung page does not answer a reload – the request waits behind the script that hung – so the
// offer for a hung account is a restart of its renderer. Really ending a renderer takes
// Playwright's connection with it (recovery.spec.js), so the ending is recorded instead of done;
// what is under test is that the offer reaches it, and that the page is loaded again after.
test('a hung account is offered a restart of its renderer', async () => {
  await mark()
  await electronApp.evaluate(({ webContents }, id) => {
    const contents = webContents.fromId(id)
    globalThis.__rendererEnded = 0
    contents.forcefullyCrashRenderer = () => {
      globalThis.__rendererEnded += 1
    }
    contents.emit('unresponsive')
  }, viewId)

  await expect(page.locator('#reload-account')).toBeVisible()
  await page.locator('#reload-account').click()

  await expect.poll(() => electronApp.evaluate(() => globalThis.__rendererEnded)).toBe(1)
  await expect.poll(markSurvives).toBe(false)
})

// The views step aside while a dialog is open, out of sight. A key pressed then is meant for the
// dialog, and a reload behind it would throw a draft away where nobody could see it go.
test('F5 while a dialog is open leaves the account alone', async () => {
  await mark()
  await page.locator('#open-settings').click()
  await expect(page.locator('#settings-dialog')).toBeVisible()
  await expect.poll(viewShown).toBe(false)

  await pressKey(electronApp, windowContentsId, 'F5')
  // Nothing to wait for when nothing happens; the second half of the test is what proves the
  // key was delivered at all.
  await page.waitForTimeout(1500)
  expect(await markSurvives()).toBe(true)

  await page.locator('#close-settings').click()
  await expect(page.locator('#settings-dialog')).toBeHidden()
  await expect.poll(viewShown).toBe(true)
  await pressKey(electronApp, windowContentsId, 'F5')
  await expect.poll(markSurvives).toBe(false)
})

// In a WebContentsView a page's refusal is silent: no dialog, no error, the reload just does not
// happen. Before this, F5 on a page with a draft did nothing at all, with nothing to say why.
test('a reload refused by a page with a draft is reported, and can be pushed through', async () => {
  await countReloads()
  await pressKey(electronApp, viewId, 'F5')
  await expect.poll(reloads).toBe(1)

  // The page refuses: the message says so and offers to go ahead, and the page is not overridden.
  expect(await refuseToUnload()).toBe(false)
  await expect(page.locator('#message')).toBeVisible()
  await expect(page.locator('#message-text')).toContainText('Account one')
  await expect(page.locator('#proceed-anyway')).toBeVisible()

  // Going ahead repeats the reload, and the refusal that repeat meets is the one let through.
  await page.locator('#proceed-anyway').click()
  await expect.poll(reloads).toBe(2)
  expect(await refuseToUnload()).toBe(true)
  await expect(page.locator('#message')).toBeHidden()

  // Once: the next refusal is the page's again.
  expect(await refuseToUnload()).toBe(false)
})

// The page's own navigations, and the mouse's back button, are refused the same way and pass
// through nothing the application asked for. There is nothing to push through – offering it
// would repeat whatever the application did last.
test('a refusal nobody here asked for is reported without an offer', async () => {
  expect(await refuseToUnload()).toBe(false)

  await expect(page.locator('#message')).toBeVisible()
  await expect(page.locator('#message-text')).toContainText('Account one')
  await expect(page.locator('#proceed-anyway')).toBeHidden()
})

// Ctrl+; in the application window belongs to the renderer. When the interceptor in the main
// process took it over as well, the palette would have stopped opening there without a single
// test noticing: every other test of this key presses it through Playwright, which never
// reaches the interceptor.
test('Ctrl+; sent the way a real key arrives opens the macro palette in the app window', async () => {
  await pressKey(electronApp, windowContentsId, ';', ['control'])
  await expect(page.locator('#macros-dialog')).toBeVisible()
})

// A session outlives its view. An account removed and added again under the same name gets the
// same partition back, and every new view used to stack another download listener on it – two
// "Downloading" messages and two save paths for one file.
test('an account removed and added again under the same name watches downloads once', async () => {
  // Added through the application, so its id is the one the application derives from the name –
  // which is what makes the second add land on the same partition.
  const add = () => page.evaluate(() => window.mHub.addAccount({ name: 'Second account', platform: 'messenger' }))
  const idOfSecond = () =>
    page.evaluate(async () => (await window.mHub.listAccounts()).find((a) => a.name === 'Second account')?.id)

  expect((await add()).ok).toBe(true)
  const firstId = await idOfSecond()
  expect((await page.evaluate((id) => window.mHub.removeAccount(id), firstId)).ok).toBe(true)
  expect((await add()).ok).toBe(true)
  expect(await idOfSecond()).toBe(firstId)

  const listeners = await electronApp.evaluate(
    ({ session }, id) => session.fromPartition(`persist:${id}`).listenerCount('will-download'),
    firstId,
  )
  expect(listeners).toBe(1)
})
