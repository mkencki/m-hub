import { test, expect, _electron as electron } from '@playwright/test'
import { createServer } from 'node:net'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { appWindowId, blankTheViews, clearStatusBar, loadInto, pressKey, servePages, webContentsIdFor } from './helpers.js'

// Back, Forward and Start for the account being looked at: the buttons on the status bar, Alt and
// the arrows, the keyboard's own Back key, and the mouse's side buttons – each one step, never two.
// The pages are local: a real service would put the test on the network and inside somebody's
// account. They are loaded from the main process, never by following a link – see servePages.

const PAGE = (title) => `<!doctype html><title>${title}</title><p>${title}</p>`
// A page that adds a step of its own when it is clicked, as Facebook does when a post is opened.
const TAP = `<!doctype html><title>tap</title><p>tap</p>
<script>document.addEventListener('click', () => history.pushState(null, '', '#post'))</script>`

let dataDir
let electronApp
let page
let server
let windowId
let windowContentsId
const viewIds = {}

test.beforeEach(async () => {
  server = await servePages({ '/one': PAGE('one'), '/two': PAGE('two'), '/three': PAGE('three'), '/tap': TAP })
  dataDir = await mkdtemp(path.join(tmpdir(), 'mhub-history-'))
  await writeFile(
    path.join(dataDir, 'accounts.json'),
    JSON.stringify({
      version: 2,
      accounts: [
        { id: 'acc-one', name: 'Account one', platform: 'facebook', url: 'https://www.facebook.com/', color: '#2f7d5b' },
        { id: 'acc-two', name: 'Account two', platform: 'whatsapp', url: 'https://web.whatsapp.com/', color: '#6586ec' },
      ],
    }),
    'utf8',
  )
  electronApp = await electron.launch({ args: ['.', `--user-data-dir=${dataDir}`] })
  page = await electronApp.firstWindow()
  await page.waitForSelector('body[data-ready="1"]')
  await expect(page.locator('.channel')).toHaveCount(2)
  windowId = await appWindowId(electronApp)
  windowContentsId = await electronApp.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).webContents.id, windowId)
  for (const [key, accountId] of [
    ['one', 'acc-one'],
    ['two', 'acc-two'],
  ]) {
    await expect.poll(() => webContentsIdFor(electronApp, accountId)).not.toBeNull()
    viewIds[key] = await webContentsIdFor(electronApp, accountId)
  }

  // Off the service pages – blanked the careful way, see blankTheViews – and onto a history that
  // starts here, so what the buttons say depends on what each test does and nothing before it. The
  // other account needs only a history with nothing behind it; a load there would add nothing but a
  // navigation in the background.
  await blankTheViews(electronApp)
  await startFresh(viewIds.one)
  await electronApp.evaluate(({ webContents }, id) => webContents.fromId(id).navigationHistory.clear(), viewIds.two)

  // A view loading in the background can take the system's focus, which the application reads as a
  // clicked notification and follows with the rail. The account under test is therefore chosen here,
  // as the operator would choose it, and checked – without moving the pointer onto the rail, which
  // would unfold it.
  await page.locator('.channel[data-account-id="acc-one"]').dispatchEvent('click')
  await expect(page.locator('.channel[data-account-id="acc-one"]')).toHaveAttribute('aria-selected', 'true')
  await clearStatusBar(page)
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

const inView = (id, script) =>
  electronApp.evaluate(({ webContents }, { id, script }) => webContents.fromId(id).executeJavaScript(script), {
    id,
    script,
  })

// The first load after blankTheViews still goes over the tail of a live page, whose report of its
// own load cut short can fail the promise of a later load – hence loadInto, for every load here.
const load = (id, pathname) => loadInto(electronApp, id, server.url(pathname))

// A view on one page with nothing behind it. Clearing the history says nothing to anybody, so the
// page then replaces its own entry – a step within the page, which the application hears like any
// other and answers by telling the status bar where the account stands.
async function startFresh(id, pathname = '/one') {
  await load(id, pathname)
  await electronApp.evaluate(({ webContents }, id) => webContents.fromId(id).navigationHistory.clear(), id)
  await inView(id, 'history.replaceState(null, "", location.href), 1')
}

// The pages of the history walkThree builds, by their place in it.
const WALK = ['/one', '/two', '/three']

// Where the view stands: its place in the history and the address it has committed. The place alone
// is not enough – getActiveIndex() moves the moment a step is ASKED for, before the page has landed,
// and a key sent on that answer meets a step still on its way (measured on CI, run 39071387442: an
// Alt+Right sent so undid the pending Back instead of taking a step of its own). The committed
// address moves only once the step has landed.
const standing = (id) =>
  electronApp.evaluate(({ webContents }, id) => {
    const contents = webContents.fromId(id)
    return { index: contents.navigationHistory.getActiveIndex(), url: contents.getURL() }
  }, id)
const at = (index) => ({ index, url: server.url(WALK[index]) })

const enabled = (selector) => page.locator(selector).isEnabled()

// Whether the main process has the account view shown – see the same helper in reload-keys.spec.js.
const viewShown = (id) =>
  electronApp.evaluate(({ BrowserWindow }, id) => {
    for (const window of BrowserWindow.getAllWindows()) {
      const view = window.contentView.children.find((child) => child.webContents?.id === id)
      if (view) return view.getVisible()
    }
    return null
  }, id)

// A press and a release of one mouse button inside an account view, through the DevTools protocol:
// the path the mouse takes into the page, user activation included, without moving the pointer of
// whoever runs the test.
const BUTTON_BITS = { left: 1, back: 8 }
const mouseInView = (id, button) =>
  electronApp.evaluate(
    async ({ webContents }, { id, button, bits }) => {
      const contents = webContents.fromId(id)
      contents.debugger.attach('1.3')
      const at = { x: 40, y: 40, clickCount: 1, button }
      await contents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', buttons: bits, ...at })
      await contents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', buttons: 0, ...at })
      contents.debugger.detach()
    },
    { id, button, bits: BUTTON_BITS[button] },
  )

// What three steps forward look like: /one, /two, /three, standing on /three.
async function walkThree(id) {
  await load(id, '/two')
  await load(id, '/three')
  await expect.poll(() => standing(id)).toEqual(at(2))
}

test('the buttons say where the account can go, and follow the account being looked at', async () => {
  await expect.poll(() => enabled('#nav-back')).toBe(false)
  await expect.poll(() => enabled('#nav-forward')).toBe(false)
  await expect.poll(() => enabled('#nav-home')).toBe(true)

  await load(viewIds.one, '/two')
  await expect.poll(() => enabled('#nav-back')).toBe(true)
  await expect.poll(() => enabled('#nav-forward')).toBe(false)

  // The other account has gone nowhere, so on it Back has nowhere to go.
  await page.locator('.channel[data-account-id="acc-two"]').click()
  await expect.poll(() => enabled('#nav-back')).toBe(false)

  await page.locator('.channel[data-account-id="acc-one"]').click()
  await expect.poll(() => enabled('#nav-back')).toBe(true)
})

test('Back on the status bar takes one step, and Forward takes it again', async () => {
  await walkThree(viewIds.one)

  await page.locator('#nav-back').click()
  await expect.poll(() => standing(viewIds.one)).toEqual(at(1))
  await expect.poll(() => enabled('#nav-forward')).toBe(true)

  await page.locator('#nav-back').click()
  await expect.poll(() => standing(viewIds.one)).toEqual(at(0))
  // At the start of the history there is nowhere further back.
  await expect.poll(() => enabled('#nav-back')).toBe(false)

  await page.locator('#nav-forward').click()
  await expect.poll(() => standing(viewIds.one)).toEqual(at(1))
})

// A button takes the keyboard with the click. Given back, typing and the next Alt+Left go to the
// page as they did before the click.
test('after a click on Back the keyboard is back in the account', async () => {
  await electronApp.evaluate(({ BrowserWindow }, id) => {
    const window = BrowserWindow.fromId(id)
    window.show()
    window.focus()
  }, windowId)
  await load(viewIds.one, '/two')

  await page.locator('#nav-back').click()

  await expect
    .poll(() => electronApp.evaluate(({ webContents }, id) => webContents.fromId(id).isFocused(), viewIds.one))
    .toBe(true)
})

// The scene this change was asked for: the network is down and the page is an error. That error
// page is a step in the history like any other, and Electron reports it only as a failed load, never
// as a navigation – so a button listening for navigations alone stayed greyed over it. A local port
// nobody listens on stands in for the missing network; Windows retries a refused connection for a
// couple of seconds before giving up, hence the longer wait.
test('a load that ends on an error page turns Back on', async () => {
  const closed = createServer()
  await new Promise((listening) => closed.listen(0, '127.0.0.1', listening))
  const port = closed.address().port
  await new Promise((done) => closed.close(done))
  await expect.poll(() => enabled('#nav-back')).toBe(false)

  await electronApp.evaluate(
    ({ webContents }, { id, address }) => webContents.fromId(id).loadURL(address).catch(() => {}),
    { id: viewIds.one, address: `http://127.0.0.1:${port}/` },
  )

  await expect.poll(() => enabled('#nav-back'), { timeout: 20000 }).toBe(true)
})

// Facebook moves between a profile, a post and a photo without loading a page: each is a step the
// page adds to its own history. Added after a click they are steps like any other, and the buttons
// have to hear about them although no page loaded.
//
// The click is a real one, sent the way the mouse sends it. A script run "as a user gesture" does
// not count: Chromium marked the step it added as one Back skips – measured on CI, run 39069581881.
test('a step the page adds after a click turns Back on', async () => {
  await startFresh(viewIds.one, '/tap')
  await expect.poll(() => enabled('#nav-back')).toBe(false)

  await mouseInView(viewIds.one, 'left')
  await expect.poll(() => enabled('#nav-back')).toBe(true)

  await page.locator('#nav-back').click()
  await expect.poll(() => inView(viewIds.one, 'location.hash')).toBe('')
})

test('Alt+Left and Alt+Right in the account view step back and forward', async () => {
  await walkThree(viewIds.one)

  await pressKey(electronApp, viewIds.one, 'Left', ['alt'])
  await expect.poll(() => standing(viewIds.one)).toEqual(at(1))

  await pressKey(electronApp, viewIds.one, 'Right', ['alt'])
  await expect.poll(() => standing(viewIds.one)).toEqual(at(2))
})

// The keyboard is in the application's own window after a click on the rail or the status bar.
// Alt+Left there still means the account being looked at.
test('Alt+Left in the app window steps back in the account being looked at', async () => {
  await walkThree(viewIds.one)
  await pressKey(electronApp, windowContentsId, 'Left', ['alt'])
  await expect.poll(() => standing(viewIds.one)).toEqual(at(1))
})

// Windows reports the keyboard's Back key as WM_APPCOMMAND, which the window hands on as
// app-command. Emitted here rather than pressed: the system's way from the key to the window
// cannot be driven from a test, and the half that turns it into a key event is answered with
// nothing at all – see key-commands.test.js, which is what pins down that there is no second step.
test('the Browser Back and Browser Forward keys step once each', async () => {
  await walkThree(viewIds.one)
  const appCommand = (name) =>
    electronApp.evaluate(({ BrowserWindow }, { id, name }) => BrowserWindow.fromId(id).emit('app-command', {}, name), {
      id: windowId,
      name,
    })

  await appCommand('browser-backward')
  await expect.poll(() => standing(viewIds.one)).toEqual(at(1))

  await appCommand('browser-forward')
  await expect.poll(() => standing(viewIds.one)).toEqual(at(2))
})

// The mouse's side buttons have stepped back from the start, done by Chromium itself. The
// application must not answer them a second time. Pressed through the DevTools protocol, the way
// the button reaches the page; three pages, so a second step would have somewhere to go.
test('the mouse back button takes exactly one step', async () => {
  await walkThree(viewIds.one)

  await mouseInView(viewIds.one, 'back')

  await expect.poll(() => standing(viewIds.one)).toEqual(at(1))
  // Nothing to wait for when nothing more happens; long enough for a second step to have landed.
  await page.waitForTimeout(1500)
  expect(await standing(viewIds.one)).toEqual(at(1))
})

// A dialog hides the views, and a key pressed then is meant for the dialog. A step behind it would
// leave a draft where nobody can see it go.
test('Alt+Left while a dialog is open leaves the account where it is', async () => {
  await walkThree(viewIds.one)
  await page.locator('#open-settings').click()
  await expect(page.locator('#settings-dialog')).toBeVisible()
  await expect.poll(() => viewShown(viewIds.one)).toBe(false)

  await pressKey(electronApp, windowContentsId, 'Left', ['alt'])
  await page.waitForTimeout(1500)
  expect(await standing(viewIds.one)).toEqual(at(2))

  // The same key once the dialog is gone proves it was delivered at all.
  await page.locator('#close-settings').click()
  await expect.poll(() => viewShown(viewIds.one)).toBe(true)
  await pressKey(electronApp, windowContentsId, 'Left', ['alt'])
  await expect.poll(() => standing(viewIds.one)).toEqual(at(1))
})

// Start goes to the account's own address. An account address has to be https, so it cannot point
// at the local server: the load is recorded instead of done.
test('Start loads the account address', async () => {
  await electronApp.evaluate(({ webContents }, id) => {
    globalThis.__loads = []
    webContents.fromId(id).loadURL = (address) => {
      globalThis.__loads.push(address)
      return Promise.resolve()
    }
  }, viewIds.one)

  await page.locator('#nav-home').click()

  await expect.poll(() => electronApp.evaluate(() => globalThis.__loads)).toEqual(['https://www.facebook.com/'])
})

// A page as Electron reports it refusing to be left – delivered directly, for the reason given in
// reload-keys.spec.js: a real beforeunload is taken by Playwright for a dialog of its own.
const refuseToUnload = (id) =>
  electronApp.evaluate(({ webContents }, id) => {
    let overridden = false
    webContents.fromId(id).emit('will-prevent-unload', {
      preventDefault: () => {
        overridden = true
      },
    })
    return overridden
  }, id)

// Back is counted rather than taken, so the page and its pretended refusal stay where they are.
test('a step back refused by a page with a draft is reported, and can be pushed through', async () => {
  await load(viewIds.one, '/two')
  await expect.poll(() => enabled('#nav-back')).toBe(true)
  await electronApp.evaluate(({ webContents }, id) => {
    globalThis.__backs = 0
    webContents.fromId(id).navigationHistory.goBack = () => {
      globalThis.__backs += 1
    }
  }, viewIds.one)
  const backs = () => electronApp.evaluate(() => globalThis.__backs)

  await page.locator('#nav-back').click()
  await expect.poll(backs).toBe(1)

  expect(await refuseToUnload(viewIds.one)).toBe(false)
  await expect(page.locator('#message-text')).toContainText('Account one')
  await expect(page.locator('#proceed-anyway')).toBeVisible()

  await page.locator('#proceed-anyway').click()
  await expect.poll(backs).toBe(2)
  expect(await refuseToUnload(viewIds.one)).toBe(true)
})

// Alt+Left at the start of the history starts nothing. Had it been written down as asked for, the
// next refusal – one of the page's own navigations – would be taken for its answer, and the status
// bar would offer to repeat a Back that never had anywhere to go.
test('a refusal after a step with nowhere to go is reported without an offer', async () => {
  await expect.poll(() => enabled('#nav-back')).toBe(false)
  await pressKey(electronApp, viewIds.one, 'Left', ['alt'])
  // Nothing shows that a key which does nothing has arrived; this is long enough for it to have.
  await page.waitForTimeout(500)

  expect(await refuseToUnload(viewIds.one)).toBe(false)

  await expect(page.locator('#message-text')).toContainText('Account one')
  await expect(page.locator('#proceed-anyway')).toBeHidden()
})
