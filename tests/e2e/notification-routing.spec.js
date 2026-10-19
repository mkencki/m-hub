import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { blankTheViews } from './helpers.js'

let dataDir
let electronApp
let page

const account = (n, color) => ({
  id: `acc-${n}`,
  name: `Account ${n}`,
  platform: 'whatsapp',
  url: 'https://web.whatsapp.com/',
  color,
})

test.beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'mhub-toast-'))
  await writeFile(
    path.join(dataDir, 'accounts.json'),
    JSON.stringify({ version: 2, accounts: [account('one', '#2f7d5b'), account('two', '#6586ec')] }),
    'utf8',
  )
  electronApp = await electron.launch({ args: ['.', `--user-data-dir=${dataDir}`] })
  page = await electronApp.firstWindow()
  await page.waitForSelector('body[data-ready="1"]')
  await expect(page.locator('.channel')).toHaveCount(2)
  await expect
    .poll(() =>
      electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.length),
    )
    .toBe(2)

  // Routing deliberately ignores focus until a view's first load has finished, because a view
  // takes the system's focus while it is being created and that is not a notification click.
  // The views are therefore given a page that certainly finishes: about:blank.
  //
  // stop() alone was not enough, and neither was stop() plus a replacement – see
  // blankTheViews for what the second attempt got wrong and what this one waits for.
  await blankTheViews(electronApp)
  await expect
    .poll(() =>
      electronApp.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].contentView.children.every((v) => v.webContents.getURL() === 'about:blank'),
      ),
    )
    .toBe(true)
})

test.afterEach(async () => {
  await electronApp.close().catch(() => {})
  const cleanup = rm(dataDir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
  await Promise.race([cleanup, new Promise((done) => setTimeout(done, 3000))])
})

const selectedChannel = () =>
  page.locator('.channel[aria-selected="true"]').getAttribute('data-account-id')

const viewHeights = () =>
  electronApp.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].contentView.children.map((v) => v.getBounds().height),
  )

// Clicking a Windows toast hands focus to the view the toast came from. Everything else –
// which channel the rail shows as current, which view has any height, what the status bar
// says – was left pointing at the account the operator had walked away from, so the
// conversation they were sent to opened inside a view zero pixels tall.
const focusView = (index) =>
  electronApp.evaluate(({ BrowserWindow }, i) => {
    BrowserWindow.getAllWindows()[0].contentView.children[i].webContents.focus()
  }, index)

test('a view taking focus makes its account the current one', async () => {
  // The precondition, stated rather than hoped for: the account the operator is looking at
  // holds the keyboard. Loading a page gives that view focus on its own, so without this the
  // second view may already hold it – and focusing something that is already focused emits
  // no event at all, which looks exactly like routing that does not work.
  await focusView(0)
  expect(await selectedChannel()).toBe('acc-one')
  expect(await viewHeights()).toEqual([expect.any(Number), 0])

  await focusView(1)

  await expect.poll(selectedChannel).toBe('acc-two')
  const heights = await viewHeights()
  expect(heights[0]).toBe(0)
  expect(heights[1]).toBeGreaterThan(0)
})

// A page loads again on its own – WhatsApp after an update, Facebook on a full page load – and
// Electron focuses a webContents on every navigation of its main frame while the window counts as
// active, a view behind the account in front included. That focus is no clicked notification. Taken
// for one, it moved the rail to the reloading account and, with the window in the background, the
// switch asked Windows for the foreground, which flashed the taskbar button orange instead. The
// reload is the page's own here, through executeJavaScript, so nothing in the application knows of it.
test('a page loading on its own behind the account in front does not take its place', async () => {
  await electronApp.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    window.show()
    window.focus()
  })
  await focusView(0)
  expect(await selectedChannel()).toBe('acc-one')

  await electronApp.evaluate(
    ({ BrowserWindow }) =>
      new Promise((landed) => {
        const contents = BrowserWindow.getAllWindows()[0].contentView.children[1].webContents
        contents.once('did-stop-loading', landed)
        contents.executeJavaScript('location.reload()').catch(() => {})
      }),
  )
  // A switch it caused would take an IPC round trip to the renderer and back; it has by now.
  await page.waitForTimeout(500)

  expect(await selectedChannel()).toBe('acc-one')
  expect(await viewHeights()).toEqual([expect.any(Number), 0])
})

// show() ends by focusing the view it just showed, so answering a focus event with a switch
// is one careless line away from a loop that never stops.
test('a view that is already current asks for nothing', async () => {
  await page.evaluate(() => {
    window.__switches = []
    window.mHub.onSelectAccountId((id) => window.__switches.push(id))
  })

  await focusView(0)
  await focusView(0)
  await page.waitForTimeout(400)

  expect(await page.evaluate(() => window.__switches)).toEqual([])
})
