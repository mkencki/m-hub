import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { appWindowId, blankTheViews, loadInto, servePages, webContentsIdFor } from './helpers.js'

// The microphone and the camera, per account, and the whole screen.
//
// Chromium's fake devices stand in for real ones (--use-fake-device-for-media-stream), so a request
// is answered by the application's permission handler and nothing else: no hardware, no prompt of
// the system's. The application's own question is a native box no test can click, so it is caught
// in the main process the way captureMenus catches a menu – the box writes down what it would have
// said and answers with the button the test names.
//
// Only the service's own page speaks for the account, so the page that asks is served under the
// service's address: the account's session answers every https request with it, from memory, and
// nothing reaches the network. Each account starts on an address Chromium refuses outright – port 1
// is on its list of unsafe ports – so nothing is fetched before the test holds the session, and no
// service worker of the real service is there to answer in the test page's place. A page served
// from 127.0.0.1 stands for one that is not the service: a sign-in page, a window opened elsewhere.

const SERVICE = 'https://web.whatsapp.com/'
const PAGE = '<!doctype html><title>media</title><p>A page that asks.</p>'

let dataDir
let electronApp
let page
let windowId
let server

test.beforeAll(async () => {
  server = await servePages({ '/': PAGE })
})

test.afterAll(async () => {
  await server.close()
})

const account = (key, name, extra = {}) => ({
  id: `acc-${key}`,
  name,
  platform: 'whatsapp',
  url: 'https://127.0.0.1:1/',
  color: '#2f7d5b',
  ...extra,
})

// Every https request the account's session makes from now on is answered with PAGE.
const serveAsService = (accountId) =>
  electronApp.evaluate(
    ({ session }, { accountId, html }) => {
      session
        .fromPartition(`persist:${accountId}`)
        .protocol.handle('https', () => new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } }))
    },
    { accountId, html: PAGE },
  )

const launch = async (accounts) => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'mhub-media-'))
  await writeFile(path.join(dataDir, 'accounts.json'), JSON.stringify({ version: 2, accounts }), 'utf8')
  electronApp = await electron.launch({ args: ['.', `--user-data-dir=${dataDir}`, '--use-fake-device-for-media-stream'] })
  page = await electronApp.firstWindow()
  await page.waitForSelector('body[data-ready="1"]')
  await expect(page.locator('.channel')).toHaveCount(accounts.length)
  windowId = await appWindowId(electronApp)
  for (const { id } of accounts) await expect.poll(() => webContentsIdFor(electronApp, id)).not.toBeNull()
  await expect(page.locator(`.channel[data-account-id="${accounts[0].id}"]`)).toHaveAttribute('aria-selected', 'true')
  await blankTheViews(electronApp)
  for (const { id } of accounts) {
    await serveAsService(id)
    await loadInto(electronApp, await webContentsIdFor(electronApp, id), SERVICE)
  }
  // Whoever is in front decides whether a question may be asked, so it is chosen, not assumed.
  const first = page.locator(`.channel[data-account-id="${accounts[0].id}"]`)
  await first.dispatchEvent('click')
  await expect(first).toHaveAttribute('aria-selected', 'true')
}

test.afterEach(async () => {
  // The bounded quit of downloads.spec.js, for the reason given there.
  await electronApp.evaluate(({ app }) => app.quit()).catch(() => {})
  const closing = electronApp.close().then(() => 'closed', () => 'closed')
  const exit = await Promise.race([closing, new Promise((over) => setTimeout(() => over('stuck'), 10000))])
  if (exit === 'stuck') electronApp.process().kill()

  const cleanup = rm(dataDir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
  await Promise.race([cleanup, new Promise((done) => setTimeout(done, 3000))])
})

// Every question main would have put on screen is written down and answered with one button –
// 0 Allow, 1 Block, 2 Not now – after holdMs, the time the operator takes to read it.
const answerQuestionsWith = (response, { holdMs = 0 } = {}) =>
  electronApp.evaluate(
    ({ dialog }, { response, holdMs }) => {
      globalThis.__questions = []
      dialog.showMessageBox = async (...args) => {
        globalThis.__questions.push(args.at(-1))
        await new Promise((read) => setTimeout(read, holdMs))
        return { response, checkboxChecked: false }
      }
    },
    { response, holdMs },
  )

const questions = () => electronApp.evaluate(() => globalThis.__questions ?? [])

// What the page gets when it asks: 'granted', or the name of the error it was refused with.
const ASK = (where, constraints) =>
  `${where}.navigator.mediaDevices.getUserMedia(${JSON.stringify(constraints)}).then(` +
  `(stream) => { stream.getTracks().forEach((track) => track.stop()); return 'granted' },` +
  ` (error) => error.name)`

const askFor = async (accountId, constraints) => {
  const id = await webContentsIdFor(electronApp, accountId)
  return electronApp.evaluate(({ webContents }, { id, code }) => webContents.fromId(id).executeJavaScript(code), {
    id,
    code: ASK('window', constraints),
  })
}

const MICROPHONE = { audio: true }
const BOTH = { audio: true, video: true }

const savedAccount = async (accountId) =>
  JSON.parse(await readFile(path.join(dataDir, 'accounts.json'), 'utf8')).accounts.find((candidate) => candidate.id === accountId)

// Until 0.8.0 this was every request there was: refused, with nobody asked.
test('a device blocked for the account is refused without a question', async () => {
  await launch([account('one', 'Account one', { microphone: 'block' })])
  await answerQuestionsWith(0)

  expect(await askFor('acc-one', MICROPHONE)).toBe('NotAllowedError')
  expect(await questions()).toEqual([])
})

test('a device allowed for the account is granted without a question', async () => {
  await launch([account('one', 'Account one', { microphone: 'allow' })])
  await answerQuestionsWith(1)

  expect(await askFor('acc-one', MICROPHONE)).toBe('granted')
  expect(await questions()).toEqual([])
})

test('a device not decided yet is asked about by the account name, and Allow is kept', async () => {
  await launch([account('one', 'Account one')])
  await answerQuestionsWith(0)

  expect(await askFor('acc-one', MICROPHONE)).toBe('granted')
  const [question] = await questions()
  expect(question.message).toBe('Account one wants to use the microphone.')
  expect(question.buttons).toEqual(['Allow', 'Block', 'Not now'])
  expect((await savedAccount('acc-one')).microphone).toBe('allow')

  // Asked once: the next request is answered from the account.
  expect(await askFor('acc-one', MICROPHONE)).toBe('granted')
  expect(await questions()).toHaveLength(1)
})

test('Block is kept too', async () => {
  await launch([account('one', 'Account one')])
  await answerQuestionsWith(1)

  expect(await askFor('acc-one', MICROPHONE)).toBe('NotAllowedError')
  expect((await savedAccount('acc-one')).microphone).toBe('block')
  expect(await askFor('acc-one', MICROPHONE)).toBe('NotAllowedError')
  expect(await questions()).toHaveLength(1)
})

// Not now refuses this once and decides nothing: the next request asks again.
test('Not now is not kept', async () => {
  await launch([account('one', 'Account one')])
  await answerQuestionsWith(2)

  expect(await askFor('acc-one', MICROPHONE)).toBe('NotAllowedError')
  expect(await savedAccount('acc-one')).not.toHaveProperty('microphone')
  expect(await askFor('acc-one', MICROPHONE)).toBe('NotAllowedError')
  expect(await questions()).toHaveLength(2)
})

test('a request for both devices names both, and the answer is kept for both', async () => {
  await launch([account('one', 'Account one')])
  await answerQuestionsWith(0)

  expect(await askFor('acc-one', BOTH)).toBe('granted')
  const [question] = await questions()
  expect(question.message).toBe('Account one wants to use the microphone and the camera.')
  expect(await savedAccount('acc-one')).toMatchObject({ microphone: 'allow', camera: 'allow' })
})

// A question naming an account the operator is not looking at would come out of nowhere.
test('an account behind the one in front is refused without a question, and stays undecided', async () => {
  await launch([account('one', 'Account one'), account('two', 'Account two', { color: '#6586ec' })])
  await answerQuestionsWith(0)

  expect(await askFor('acc-two', MICROPHONE)).toBe('NotAllowedError')
  expect(await questions()).toEqual([])
  expect(await savedAccount('acc-two')).not.toHaveProperty('microphone')
})

// The settings speak for the account, and the account is its service. A page in the account's
// session that is not the service's own is no part of that – neither the allow nor a question.
test('a page that is not the service is refused without a question, whatever the account says', async () => {
  await launch([account('one', 'Account one', { microphone: 'allow' })])
  await answerQuestionsWith(0)
  await loadInto(electronApp, await webContentsIdFor(electronApp, 'acc-one'), server.url('/'))

  expect(await askFor('acc-one', MICROPHONE)).toBe('NotAllowedError')
  expect(await questions()).toEqual([])
})

// Blink takes one request at a time per frame, so two at once come from two frames – here the page
// and a frame inside it. They are the same request, and the operator is asked about it once. Not
// now is the answer that shows it: kept nowhere, it would be asked again by a second question.
test('the same request made twice at once is asked about once, and both get the answer', async () => {
  await launch([account('one', 'Account one')])
  await answerQuestionsWith(2, { holdMs: 1000 })

  const id = await webContentsIdFor(electronApp, 'acc-one')
  const answers = await electronApp.evaluate(({ webContents }, { id, code }) => webContents.fromId(id).executeJavaScript(code), {
    id,
    code:
      `(async () => {` +
      ` const frame = document.createElement('iframe');` +
      ` frame.src = '/frame';` +
      ` await new Promise((loaded) => { frame.onload = loaded; document.body.append(frame) });` +
      ` return Promise.all([${ASK('window', MICROPHONE)}, ${ASK('frame.contentWindow', MICROPHONE)}]);` +
      `})()`,
  })

  expect(answers).toEqual(['NotAllowedError', 'NotAllowedError'])
  expect(await questions()).toHaveLength(1)
})

// The whole screen: granted without a question, and the account view given the whole window. A page
// refused it is never told so – Electron leaves its request unanswered – hence the deadline.
const requestScreen = async (accountId) => {
  const id = await webContentsIdFor(electronApp, accountId)
  return electronApp.evaluate(
    ({ webContents }, id) =>
      webContents.fromId(id).executeJavaScript(
        `Promise.race([` +
          `document.documentElement.requestFullscreen().then(() => 'granted', (error) => error.name),` +
          ` new Promise((settle) => setTimeout(() => settle('no answer'), 5000)),` +
          `])`,
        true,
      ),
    id,
  )
}

const leaveScreen = async (accountId) => {
  const id = await webContentsIdFor(electronApp, accountId)
  return electronApp.evaluate(({ webContents }, id) => webContents.fromId(id).executeJavaScript('document.exitFullscreen()'), id)
}

// Whether the page believes it has the whole screen.
const pageHoldsScreen = async (accountId) => {
  const id = await webContentsIdFor(electronApp, accountId)
  return electronApp.evaluate(
    ({ webContents }, id) => webContents.fromId(id).executeJavaScript('document.fullscreenElement !== null'),
    id,
  )
}

// Where an account's view stands against the window's content area, and whether the window is full
// screen.
const layoutOf = (accountId) =>
  electronApp.evaluate(
    ({ BrowserWindow, session }, { windowId, accountId }) => {
      const window = BrowserWindow.fromId(windowId)
      const wanted = session.fromPartition(`persist:${accountId}`)
      const view = window.contentView.children.find((child) => child.webContents?.session === wanted)
      const { width, height } = window.getContentBounds()
      return { view: view?.getBounds() ?? null, content: { width, height }, fullScreen: window.isFullScreen() }
    },
    { windowId, accountId },
  )

const coversTheWindow = ({ view, content }) =>
  view.x === 0 && view.y === 0 && view.width === content.width && view.height === content.height

test('a page that asks for the whole screen gets it, over the rail and the status bar', async () => {
  await launch([account('one', 'Account one')])

  expect(await requestScreen('acc-one')).toBe('granted')
  await expect.poll(async () => coversTheWindow(await layoutOf('acc-one'))).toBe(true)
  expect((await layoutOf('acc-one')).fullScreen).toBe(true)

  await leaveScreen('acc-one')
  await expect.poll(async () => (await layoutOf('acc-one')).view.x).toBeGreaterThan(0)
  await expect.poll(async () => (await layoutOf('acc-one')).fullScreen).toBe(false)
})

test('a page that is not the service does not get the whole screen', async () => {
  await launch([account('one', 'Account one')])
  await loadInto(electronApp, await webContentsIdFor(electronApp, 'acc-one'), server.url('/'))

  expect(await requestScreen('acc-one')).not.toBe('granted')
  const layout = await layoutOf('acc-one')
  expect(layout.fullScreen).toBe(false)
  expect(coversTheWindow(layout)).toBe(false)
})

// The page holding the screen goes out of sight, and a window left full screen would have no title
// bar and no way back but that page – so the window is lent back. The page is not told: nothing
// public makes it let go. So coming back to it gives it the screen it still believes it has, and
// the window is full screen exactly while the account in front holds the screen.
test('going to another account lends the screen back, and coming back returns it', async () => {
  await launch([account('one', 'Account one'), account('two', 'Account two', { color: '#6586ec' })])
  const one = page.locator('.channel[data-account-id="acc-one"]')
  const two = page.locator('.channel[data-account-id="acc-two"]')

  expect(await requestScreen('acc-one')).toBe('granted')
  await expect.poll(async () => coversTheWindow(await layoutOf('acc-one'))).toBe(true)

  await two.dispatchEvent('click')
  await expect(two).toHaveAttribute('aria-selected', 'true')
  await expect.poll(async () => (await layoutOf('acc-two')).fullScreen).toBe(false)
  await expect.poll(async () => (await layoutOf('acc-two')).view.x).toBeGreaterThan(0)
  expect((await layoutOf('acc-one')).view.height).toBe(0)

  await one.dispatchEvent('click')
  await expect(one).toHaveAttribute('aria-selected', 'true')
  expect(await pageHoldsScreen('acc-one')).toBe(true)
  await expect.poll(async () => (await layoutOf('acc-one')).fullScreen).toBe(true)
  await expect.poll(async () => coversTheWindow(await layoutOf('acc-one'))).toBe(true)

  await leaveScreen('acc-one')
  await expect.poll(async () => (await layoutOf('acc-one')).fullScreen).toBe(false)
  await expect.poll(async () => (await layoutOf('acc-one')).view.x).toBeGreaterThan(0)
})
