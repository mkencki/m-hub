import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  appWindowId,
  blankTheViews,
  captureMenus,
  clickMenuItem,
  lastMenu,
  pressKey,
  servePages,
  webContentsIdFor,
} from './helpers.js'

// The helpers the next changes are tested with – F5, a menu on a rail channel, back and forward,
// accounts put to sleep – checked on their own first. A helper that quietly does nothing turns
// every test built on it into a test of nothing, and it would be found only after the feature it
// was meant to prove had been written on top of it.

let dataDir
let electronApp
let page
let windowId

test.beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'mhub-helpers-'))
  await writeFile(
    path.join(dataDir, 'accounts.json'),
    JSON.stringify({
      version: 2,
      accounts: [
        { id: 'acc-one', name: 'Account one', platform: 'whatsapp', url: 'https://web.whatsapp.com/', color: '#2f7d5b' },
        { id: 'acc-two', name: 'Account two', platform: 'messenger', url: 'https://www.messenger.com/', color: '#6586ec' },
      ],
    }),
    'utf8',
  )
  electronApp = await electron.launch({ args: ['.', `--user-data-dir=${dataDir}`] })
  page = await electronApp.firstWindow()
  await page.waitForSelector('body[data-ready="1"]')
  windowId = await appWindowId(electronApp)
  await expect
    .poll(() =>
      electronApp.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).contentView.children.length, windowId),
    )
    .toBe(2)
  await blankTheViews(electronApp)
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

const sessionPartitionOf = (webContentsId, accountId) =>
  electronApp.evaluate(
    ({ webContents, session }, { id, accountId }) =>
      webContents.fromId(id).session === session.fromPartition(`persist:${accountId}`),
    { id: webContentsId, accountId },
  )

test('webContentsIdFor finds each account by its partition, not by its place', async () => {
  const one = await webContentsIdFor(electronApp, 'acc-one')
  const two = await webContentsIdFor(electronApp, 'acc-two')

  expect(one).not.toBeNull()
  expect(two).not.toBeNull()
  expect(one).not.toBe(two)
  expect(await sessionPartitionOf(one, 'acc-one')).toBe(true)
  expect(await sessionPartitionOf(two, 'acc-two')).toBe(true)
  expect(await webContentsIdFor(electronApp, 'acc-none')).toBeNull()
})

// What this answers is whether a key with no Ctrl on it – F5, Alt+Left – reaches
// before-input-event when it is sent this way, in the window and in an account view. Every key
// test so far sent Ctrl and a letter, so the question was open. The keys are not handled by the
// application yet, so a listener added here is all that hears them.
for (const [name, keyCode, modifiers, expected] of [
  ['F5', 'F5', [], { key: 'F5', alt: false, control: false }],
  ['Alt+Left', 'Left', ['alt'], { key: 'ArrowLeft', alt: true, control: false }],
]) {
  for (const where of ['window', 'view']) {
    test(`pressKey delivers ${name} to before-input-event in the ${where}`, async () => {
      const id =
        where === 'window'
          ? await electronApp.evaluate(({ BrowserWindow }, windowId) => BrowserWindow.fromId(windowId).webContents.id, windowId)
          : await webContentsIdFor(electronApp, 'acc-one')

      await electronApp.evaluate(({ webContents }, id) => {
        globalThis.__seenKeys = []
        webContents.fromId(id).on('before-input-event', (_event, input) => {
          if (input.type === 'keyDown') globalThis.__seenKeys.push({ key: input.key, alt: input.alt, control: input.control })
        })
      }, id)

      await pressKey(electronApp, id, keyCode, modifiers)

      await expect.poll(() => electronApp.evaluate(() => globalThis.__seenKeys)).toEqual([expected])
    })
  }
}

test('captureMenus records a popup instead of showing it, and clicks an item by id', async () => {
  await captureMenus(electronApp)

  await electronApp.evaluate(({ BrowserWindow, Menu }, id) => {
    globalThis.__menuEvents = []
    Menu.buildFromTemplate([
      { id: 'first', label: 'First', click: () => globalThis.__menuEvents.push('first') },
      { id: 'later', label: 'Later', enabled: false },
    ]).popup({ window: BrowserWindow.fromId(id), callback: () => globalThis.__menuEvents.push('closed') })
  }, windowId)

  expect(await lastMenu(electronApp)).toEqual([
    { id: 'first', label: 'First', enabled: true },
    { id: 'later', label: 'Later', enabled: false },
  ])

  await clickMenuItem(electronApp, 'first')
  expect(await electronApp.evaluate(() => globalThis.__menuEvents)).toEqual(['first', 'closed'])

  await expect(clickMenuItem(electronApp, 'missing')).rejects.toThrow(/missing/)
})

test('servePages serves a page an account view can load', async () => {
  const pages = await servePages({ '/one': '<!doctype html><title>page one</title>' })
  try {
    const id = await webContentsIdFor(electronApp, 'acc-one')
    const title = await electronApp.evaluate(
      async ({ webContents }, { id, url }) => {
        const view = webContents.fromId(id)
        await view.loadURL(url)
        return view.getTitle()
      },
      { id, url: pages.url('/one') },
    )
    expect(title).toBe('page one')
  } finally {
    await pages.close()
  }
})
