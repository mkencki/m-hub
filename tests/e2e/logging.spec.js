import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { blankTheViews } from './helpers.js'

let dataDir
let electronApp
let page

test.beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'mhub-logging-'))
  await writeFile(
    path.join(dataDir, 'accounts.json'),
    JSON.stringify({
      version: 2,
      accounts: [
        { id: 'acc-work', name: 'Anna Nowak private', platform: 'whatsapp', url: 'https://web.whatsapp.com/', color: '#2f7d5b' },
      ],
    }),
    'utf8',
  )
  electronApp = await electron.launch({ args: ['.', `--user-data-dir=${dataDir}`] })
  page = await electronApp.firstWindow()
  await page.waitForSelector('body[data-ready="1"]')
})

test.afterEach(async () => {
  await electronApp.close().catch(() => {})
  const cleanup = rm(dataDir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
  await Promise.race([cleanup, new Promise((done) => setTimeout(done, 3000))])
})

const readLog = () => readFile(path.join(dataDir, 'logs', 'm-hub.log'), 'utf8')

// Nothing lands on disk today: the only channel for a message is the status bar, which is
// gone the moment it is dismissed. Someone helping a friend whose app will not sign in has
// nothing to look at.
test('the app writes a log where the operator can find it', async () => {
  await expect.poll(() => readLog().catch(() => null)).not.toBeNull()

  expect(await readLog()).toContain('started')
})

// The count on the started line is the first thing to look at when somebody says their
// accounts are gone: a profile that used to hold three and now says zero is the whole
// diagnosis. It has to be the number the application actually loaded, not a placeholder.
test('the started line says how many accounts the profile held', async () => {
  await expect.poll(() => readLog().catch(() => null)).not.toBeNull()

  expect(await readLog()).toContain('started count=1')
})

// The log is meant to be sent to somebody. Everything in it has to be safe to hand over,
// which is why an account is recorded by its id and never by the name someone typed in –
// that name is frequently a person.
test('a crash is recorded by account id, not by the name of a person', async () => {
  await expect
    .poll(() =>
      electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.length),
    )
    .toBe(1)

  await electronApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]
      .contentView.children[0].webContents.emit('render-process-gone', {}, { reason: 'crashed' })
  })

  await expect.poll(async () => (await readLog()).includes('account-crashed')).toBe(true)
  const log = await readLog()
  expect(log).toContain('account=acc-work')
  expect(log).not.toContain('Anna')
  expect(log).not.toContain('Nowak')
})

// What an awake account costs is the number the decision on putting accounts to sleep waits
// for. Opening Settings writes it down – asked here the way the nameplate asks – in whole
// megabytes, against the account id.
test('opening Settings writes down what each awake account costs in memory', async () => {
  // The fields come out in the order of LOGGED_FIELDS in log.js, whatever order they are given in.
  const memoryLine = /account-memory account=acc-work platform=whatsapp reason=awake count=\d+/

  // The view's renderer starts with the view, but nothing promises it before the window is
  // ready, so the question is asked until there is a process to answer it.
  await expect
    .poll(async () => {
      await page.evaluate(() => window.mHub.about())
      return memoryLine.test(await readLog().catch(() => ''))
    })
    .toBe(true)
  expect(await readLog()).not.toContain('Anna')
})

// The decision on popups waits for how many are sign-ins and how many are articles. The log
// says which kind of host a window was asked for, and never the address – that is where the
// person or the page would be.
test('a window a page asks for is logged by the kind of host, never by its address', async () => {
  await expect
    .poll(() =>
      electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.length),
    )
    .toBe(1)
  // about:blank gives the view a script context of its own to ask for the window from – see
  // blankTheViews.
  await blankTheViews(electronApp)
  // An outgoing link is handed to the system browser. Nothing here is about that browser, so
  // the hand-over is answered on the spot instead of opening one on the machine running this.
  await electronApp.evaluate(({ shell }) => {
    shell.openExternal = async () => {}
  })

  await electronApp.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]
      .contentView.children[0].webContents.executeJavaScript(
        'window.open("https://example.org/anna-nowak/private-album?from=chat"), 1',
      ),
  )

  await expect
    .poll(async () => /window-open account=acc-work platform=whatsapp code=external reason=\S+/.test(await readLog()))
    .toBe(true)
  const log = await readLog()
  expect(log).not.toContain('example.org')
  expect(log).not.toContain('anna-nowak')
  expect(log).not.toContain('private-album')
})
