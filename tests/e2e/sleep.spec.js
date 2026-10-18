import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { appWindowId, blankTheViews, captureMenus, clearStatusBar, clickMenuItem, lastMenu, webContentsIdFor } from './helpers.js'

// Putting an account to sleep, by hand, and waking it. Sleep closes the account's view and waking
// makes a new one on the same partition, so what is tested is the view count, the rail, the status
// bar and what the main process still listens to – never a page's memory, which a runner cannot
// tell apart from noise. The menu is the channel menu, caught on its way out as in
// channel-menu.spec.js; the rail is clicked with dispatchEvent, which leaves the pointer where it
// is and the rail folded.

let dataDir
let electronApp
let page
let windowId

test.beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'mhub-sleep-'))
  await writeFile(
    path.join(dataDir, 'accounts.json'),
    JSON.stringify({
      version: 2,
      accounts: [
        { id: 'acc-one', name: 'Account one', platform: 'whatsapp', url: 'https://web.whatsapp.com/', color: '#2f7d5b' },
        { id: 'acc-two', name: 'Account two', platform: 'whatsapp', url: 'https://web.whatsapp.com/', color: '#6586ec' },
        { id: 'acc-three', name: 'Account three', platform: 'messenger', url: 'https://www.messenger.com/', color: '#c9a227' },
      ],
    }),
    'utf8',
  )
  electronApp = await electron.launch({ args: ['.', `--user-data-dir=${dataDir}`] })
  page = await electronApp.firstWindow()
  await page.waitForSelector('body[data-ready="1"]')
  await expect(page.locator('.channel')).toHaveCount(3)
  windowId = await appWindowId(electronApp)
  for (const accountId of ['acc-one', 'acc-two', 'acc-three']) {
    await expect.poll(() => webContentsIdFor(electronApp, accountId)).not.toBeNull()
  }
  // Off the service pages, the careful way – see blankTheViews – so a close meets a page that has
  // finished loading, as an account the operator chooses to put to sleep usually has.
  await blankTheViews(electronApp)
  await page.locator('.channel[data-account-id="acc-one"]').dispatchEvent('click')
  await expect(channel('acc-one')).toHaveAttribute('aria-selected', 'true')
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

const channel = (accountId) => page.locator(`.channel[data-account-id="${accountId}"]`)

// How many account views the window holds – the awake accounts, since a sleeping one has none.
const viewCount = () =>
  electronApp.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).contentView.children.length, windowId)

// The height of an account's view, or null when it has none. The account in front is the one view
// with a height; the others are zero pixels tall.
const viewHeight = (accountId) =>
  electronApp.evaluate(
    ({ BrowserWindow, session }, { windowId, accountId }) => {
      const wanted = session.fromPartition(`persist:${accountId}`)
      const view = BrowserWindow.fromId(windowId).contentView.children.find((child) => child.webContents?.session === wanted)
      return view ? view.getBounds().height : null
    },
    { windowId, accountId },
  )

const menuFor = async (accountId) => {
  await page.evaluate((id) => window.mHub.openChannelMenu(id), accountId)
  return lastMenu(electronApp)
}

const itemOf = (items, id) => items.find((item) => item.id === id)

const sleep = async (accountId) => {
  await menuFor(accountId)
  await clickMenuItem(electronApp, 'sleep')
}

const asleep = async (accountId) => {
  await expect(channel(accountId)).toHaveClass(/\basleep\b/)
  await expect.poll(() => webContentsIdFor(electronApp, accountId)).toBeNull()
}

test('an account put to sleep loses its view and its channel says asleep, not read', async () => {
  await expect(channel('acc-two').locator('.channel-meta')).toHaveText('no new')

  await sleep('acc-two')

  await asleep('acc-two')
  expect(await viewCount()).toBe(2)
  await expect(channel('acc-two').locator('.channel-meta')).toHaveText('asleep')
  await expect(channel('acc-two')).not.toHaveClass(/has-unread/)
  await expect(channel('acc-two')).toHaveAttribute('title', /asleep/)
  await expect(page.locator('#status-unread')).toContainText('1 asleep')
  // The operator stays where they were.
  await expect(channel('acc-one')).toHaveAttribute('aria-selected', 'true')
  expect(await viewHeight('acc-one')).toBeGreaterThan(0)
})

test('a sleeping account clicked on the rail wakes and is shown', async () => {
  await sleep('acc-two')
  await asleep('acc-two')

  await channel('acc-two').dispatchEvent('click')

  await expect.poll(() => webContentsIdFor(electronApp, 'acc-two')).not.toBeNull()
  expect(await viewCount()).toBe(3)
  await expect(channel('acc-two')).not.toHaveClass(/\basleep\b/)
  await expect(channel('acc-two')).toHaveAttribute('aria-selected', 'true')
  await expect.poll(() => viewHeight('acc-two')).toBeGreaterThan(0)
  await expect(page.locator('#status-unread')).not.toContainText('asleep')
})

// Waking makes a new view on the same session, and the session outlives every view it ever had.
// A listener registered per view would pile up there with every wake – a second "Downloading"
// message for one file – while the new view has to get its own navigation gate.
test('three sleeps and wakes leave one download listener and a gated view', async () => {
  for (let round = 0; round < 3; round += 1) {
    await sleep('acc-two')
    await asleep('acc-two')
    await menuFor('acc-two')
    await clickMenuItem(electronApp, 'wake')
    await expect.poll(() => webContentsIdFor(electronApp, 'acc-two')).not.toBeNull()
    // Woken in the background: the operator is still on the account they were using.
    await expect(channel('acc-one')).toHaveAttribute('aria-selected', 'true')
  }

  const listeners = await electronApp.evaluate(({ session, webContents }, id) => {
    const contents = webContents.fromId(id)
    return {
      downloads: session.fromPartition('persist:acc-two').listenerCount('will-download'),
      navigation: contents.listenerCount('will-navigate'),
      windows: contents.listenerCount('did-create-window'),
    }
  }, await webContentsIdFor(electronApp, 'acc-two'))
  expect(listeners.downloads).toBe(1)
  expect(listeners.navigation).toBeGreaterThan(0)
  expect(listeners.windows).toBeGreaterThan(0)
  expect(await viewHeight('acc-two')).toBe(0)
})

// The application announces a crash, a hang and a failed load. Closing a view on purpose must not
// look like any of them – what the view reported on its way out is counted, and the bar stays empty.
test('falling asleep reports no crash, no hang and no failed load', async () => {
  const id = await webContentsIdFor(electronApp, 'acc-two')
  await electronApp.evaluate(({ webContents }, id) => {
    globalThis.__closing = []
    const contents = webContents.fromId(id)
    for (const name of ['render-process-gone', 'unresponsive', 'did-fail-load']) {
      contents.on(name, (_event, code) => globalThis.__closing.push({ name, code: typeof code === 'number' ? code : null }))
    }
  }, id)

  await sleep('acc-two')
  await asleep('acc-two')
  await page.waitForTimeout(1000)

  const reported = await electronApp.evaluate(() => globalThis.__closing)
  expect(reported.filter((event) => event.name !== 'did-fail-load' || event.code !== -3)).toEqual([])
  await expect(page.locator('#message')).toBeHidden()
})

// A page holding a draft refuses a close that asks it first. A real beforeunload cannot stand in
// for that here – Playwright takes it for a dialog of its own (reload-keys.spec.js) – so the close
// the application asks for answers the way Electron does when a page refuses: will-prevent-unload,
// and the view closes only when someone overrode it. Answered a moment later, as the page's answer
// comes from its renderer, never inside the call that asked.
test('a page that refuses to be left keeps its account awake and offers to sleep anyway', async () => {
  const id = await webContentsIdFor(electronApp, 'acc-two')
  await electronApp.evaluate(({ webContents }, id) => {
    const contents = webContents.fromId(id)
    const close = contents.close.bind(contents)
    globalThis.__closeCalls = []
    contents.close = (options) => {
      globalThis.__closeCalls.push(options ?? null)
      if (!options?.waitForBeforeUnload) return close()
      setTimeout(() => {
        let overridden = false
        contents.emit('will-prevent-unload', {
          preventDefault: () => {
            overridden = true
          },
        })
        if (overridden) close()
      }, 20)
    }
  }, id)

  await sleep('acc-two')

  await expect(page.locator('#message-text')).toContainText('Account two')
  await expect(page.locator('#proceed-anyway')).toBeVisible()
  await expect(page.locator('#proceed-anyway')).toHaveText('Sleep anyway')
  expect(await electronApp.evaluate(() => globalThis.__closeCalls)).toEqual([{ waitForBeforeUnload: true }])
  expect(await viewCount()).toBe(3)
  await expect(channel('acc-two')).not.toHaveClass(/\basleep\b/)

  await page.locator('#proceed-anyway').click()

  await asleep('acc-two')
  expect(await viewCount()).toBe(2)
})

test('the account in front cannot be put to sleep', async () => {
  const items = await menuFor('acc-one')
  expect(itemOf(items, 'sleep')).toMatchObject({ enabled: false })
  expect(itemOf(items, 'sleep-others')).toMatchObject({ enabled: true })
})

// Closing an account's view would close the windows its page opened – a sign-in under way, a
// comment being typed – so an account with one open stays awake, and says why.
test('an account with a window of its own stays awake, and sleeping the others names it', async () => {
  const id = await webContentsIdFor(electronApp, 'acc-two')
  await electronApp.evaluate(({ BrowserWindow, webContents }, id) => {
    const child = new BrowserWindow({ show: false })
    webContents.fromId(id).emit('did-create-window', child, { url: 'about:blank' })
  }, id)

  const items = await menuFor('acc-two')
  expect(itemOf(items, 'sleep').enabled).toBe(false)
  expect(itemOf(items, 'sleep').label).toMatch(/window/)

  await menuFor('acc-one')
  await clickMenuItem(electronApp, 'sleep-others')

  await asleep('acc-three')
  await expect(page.locator('#message-text')).toContainText('Account two')
  expect(await webContentsIdFor(electronApp, 'acc-two')).not.toBeNull()
  await expect(channel('acc-two')).not.toHaveClass(/\basleep\b/)
  await expect(channel('acc-one')).toHaveAttribute('aria-selected', 'true')
})

// The laptop resumes rather than restarts, so the start would not remind anybody of an account
// left asleep. Waking it is offered, never done.
test('after the computer wakes the status bar offers to wake sleeping accounts and wakes none', async () => {
  await sleep('acc-two')
  await asleep('acc-two')
  await clearStatusBar(page)

  await electronApp.evaluate(({ powerMonitor }) => powerMonitor.emit('resume'))

  await expect(page.locator('#wake-all')).toBeVisible()
  await page.waitForTimeout(500)
  expect(await viewCount()).toBe(2)
  await expect(channel('acc-two')).toHaveClass(/\basleep\b/)

  await page.locator('#wake-all').click()

  await expect.poll(() => webContentsIdFor(electronApp, 'acc-two')).not.toBeNull()
  expect(await viewCount()).toBe(3)
  await expect(channel('acc-two')).not.toHaveClass(/\basleep\b/)
  await expect(channel('acc-one')).toHaveAttribute('aria-selected', 'true')
})

// Regression class from 2026-08-24: a view emitting events on its way out reached for a window that
// was already gone, and Electron's modal "Object has been destroyed" blocked the exit.
test('a sleeping account and a quit raise no exception in the main process', async () => {
  const stderrOutput = []
  electronApp.process().stderr.on('data', (chunk) => stderrOutput.push(String(chunk)))

  await sleep('acc-two')
  await asleep('acc-two')
  await sleep('acc-three')
  await electronApp.close()

  expect(stderrOutput.join('')).not.toMatch(/Object has been destroyed|Uncaught Exception/)
})
