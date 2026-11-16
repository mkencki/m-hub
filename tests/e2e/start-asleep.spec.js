import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  appWindowId,
  blankTheViews,
  captureMenus,
  captureTrayMenu,
  clearStatusBar,
  clickMenuItem,
  clickTrayItem,
  trayItems,
  webContentsIdFor,
} from './helpers.js'

// Accounts set to start asleep, and the tray's two items about sleep. An account set so is asleep
// from the first moment: no view, a channel that says so, and a wake like any other sleeping
// account's. The reminder is told apart by what it says after a resume, as in sleep.spec.js. The
// rail is clicked with dispatchEvent, which leaves the pointer where it is and the rail folded.

let dataDir
let electronApp
let page
let windowId

const account = (key, name, extra = {}) => ({
  id: `acc-${key}`,
  name,
  platform: 'whatsapp',
  url: 'https://web.whatsapp.com/',
  color: '#2f7d5b',
  ...extra,
})

// The first set to start asleep, the other two not – so the account in front is the second.
const ACCOUNTS = [
  account('one', 'Account one', { startAsleep: true }),
  account('two', 'Account two', { color: '#6586ec' }),
  account('three', 'Account three', { color: '#c9a227' }),
]

const launch = async (accounts = ACCOUNTS) => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'mhub-start-asleep-'))
  await writeFile(path.join(dataDir, 'accounts.json'), JSON.stringify({ version: 2, accounts }), 'utf8')
  electronApp = await electron.launch({ args: ['.', `--user-data-dir=${dataDir}`] })
  page = await electronApp.firstWindow()
  await page.waitForSelector('body[data-ready="1"]')
  await expect(page.locator('.channel')).toHaveCount(accounts.length)
  windowId = await appWindowId(electronApp)
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

const channel = (accountId) => page.locator(`.channel[data-account-id="${accountId}"]`)

const viewCount = () =>
  electronApp.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).contentView.children.length, windowId)

const savedAccounts = async () => JSON.parse(await readFile(path.join(dataDir, 'accounts.json'), 'utf8')).accounts

const itemOf = (items, id) => items.find((item) => item.id === id)

const asleep = async (accountId) => {
  await expect(channel(accountId)).toHaveClass(/\basleep\b/)
  await expect.poll(() => webContentsIdFor(electronApp, accountId)).toBeNull()
}

// The point of the setting: the page of an account set to start asleep is never loaded, so it costs
// nothing – and the rail's own first choice of the account in front must not load it either. Before
// the rail knew which accounts were asleep when it first chose, it chose the first account, which
// woke it.
test('an account set to start asleep gets no view, and the first awake account is in front', async () => {
  await launch()

  await expect(channel('acc-two')).toHaveAttribute('aria-selected', 'true')
  await expect(channel('acc-one')).toHaveClass(/\basleep\b/)
  await expect(channel('acc-one').locator('.channel-meta')).toHaveText('asleep')
  await expect.poll(viewCount).toBe(2)
  await page.waitForTimeout(1000)
  expect(await webContentsIdFor(electronApp, 'acc-one')).toBeNull()
  await expect(page.locator('#status-unread')).toContainText('1 asleep')
})

test('a click on it wakes it and shows it', async () => {
  await launch()
  await expect(channel('acc-two')).toHaveAttribute('aria-selected', 'true')

  await channel('acc-one').dispatchEvent('click')

  await expect.poll(() => webContentsIdFor(electronApp, 'acc-one')).not.toBeNull()
  await expect(channel('acc-one')).toHaveAttribute('aria-selected', 'true')
  await expect(channel('acc-one')).not.toHaveClass(/\basleep\b/)
  expect(await viewCount()).toBe(3)
})

// Something has to be in front – the rule the rail keeps when the account in front goes.
test('with every account set to start asleep, the first one wakes', async () => {
  await launch([account('one', 'Account one', { startAsleep: true }), account('two', 'Account two', { startAsleep: true })])

  await expect(channel('acc-one')).toHaveAttribute('aria-selected', 'true')
  await expect.poll(() => webContentsIdFor(electronApp, 'acc-one')).not.toBeNull()
  await expect(channel('acc-two')).toHaveClass(/\basleep\b/)
  expect(await webContentsIdFor(electronApp, 'acc-two')).toBeNull()
})

// An account set to start asleep is asleep by choice. The reminder exists for accounts the operator
// might have forgotten, and would only nag about this one.
test('the reminder after a resume says nothing of an account asleep by choice', async () => {
  await launch()
  await expect(channel('acc-two')).toHaveAttribute('aria-selected', 'true')
  await expect.poll(() => webContentsIdFor(electronApp, 'acc-three')).not.toBeNull()
  // Off the service pages, so no failed load can take the status bar while it is read.
  await blankTheViews(electronApp)
  await clearStatusBar(page)

  await electronApp.evaluate(({ powerMonitor }) => powerMonitor.emit('resume'))

  await expect(page.locator('#message-text')).toHaveText('The computer woke up. Accounts may need reloading.')
  await expect(page.locator('#wake-all')).toBeHidden()
})

test("a reminder's Wake wakes the accounts it counted, and not the one asleep by choice", async () => {
  await launch()
  await expect(channel('acc-two')).toHaveAttribute('aria-selected', 'true')
  await expect.poll(() => webContentsIdFor(electronApp, 'acc-three')).not.toBeNull()
  await blankTheViews(electronApp)
  await captureMenus(electronApp)
  await page.evaluate(() => window.mHub.openChannelMenu('acc-three'))
  await clickMenuItem(electronApp, 'sleep')
  await asleep('acc-three')
  await clearStatusBar(page)

  await electronApp.evaluate(({ powerMonitor }) => powerMonitor.emit('resume'))
  await expect(page.locator('#message-text')).toContainText('1 account is asleep')
  await page.locator('#wake-all').click()

  await expect.poll(() => webContentsIdFor(electronApp, 'acc-three')).not.toBeNull()
  await page.waitForTimeout(500)
  expect(await webContentsIdFor(electronApp, 'acc-one')).toBeNull()
  await expect(channel('acc-one')).toHaveClass(/\basleep\b/)
})

// The operator's scenario from the channel menu, from the tray – and waking every account, the ones
// set to start asleep included: there the operator asks for all of them.
test('the tray puts all but the current account to sleep, and wakes every one', async () => {
  await launch()
  await expect(channel('acc-two')).toHaveAttribute('aria-selected', 'true')
  await expect.poll(() => webContentsIdFor(electronApp, 'acc-three')).not.toBeNull()
  await blankTheViews(electronApp)
  await captureTrayMenu(electronApp, page)

  const items = await trayItems(electronApp)
  expect(itemOf(items, 'sleep-others').enabled).toBe(true)
  expect(itemOf(items, 'wake-all').enabled).toBe(true)

  await clickTrayItem(electronApp, 'sleep-others')
  await asleep('acc-three')
  await expect(channel('acc-two')).toHaveAttribute('aria-selected', 'true')
  await expect.poll(async () => itemOf(await trayItems(electronApp), 'sleep-others').enabled).toBe(false)

  await clickTrayItem(electronApp, 'wake-all')
  await expect.poll(() => webContentsIdFor(electronApp, 'acc-one')).not.toBeNull()
  await expect.poll(() => webContentsIdFor(electronApp, 'acc-three')).not.toBeNull()
  await expect.poll(async () => itemOf(await trayItems(electronApp), 'wake-all').enabled).toBe(false)
  await expect(channel('acc-two')).toHaveAttribute('aria-selected', 'true')
})

// Both settings live where notifications do, in the account's own settings – and saving them changes
// nothing now: starting asleep is about the next start.
test('the account settings hold the start and the devices', async () => {
  await launch()
  await expect(channel('acc-two')).toHaveAttribute('aria-selected', 'true')
  const form = page.locator('#account-dialog')

  await page.locator('#open-settings').click()
  await page.locator('#account-list .edit-account').first().click()
  await expect(form.locator('input[name="startAsleep"]')).toBeChecked()
  await form.locator('button[value="cancel"]').click()
  await expect(form).toBeHidden()

  await page.locator('#account-list .edit-account').nth(1).click()
  await expect(form.locator('input[name="startAsleep"]')).not.toBeChecked()
  await expect(form.locator('select[name="microphone"]')).toHaveValue('ask')
  await expect(form.locator('select[name="camera"]')).toHaveValue('ask')
  await form.locator('input[name="startAsleep"]').check()
  await form.locator('select[name="microphone"]').selectOption('allow')
  await form.locator('select[name="camera"]').selectOption('block')
  await page.locator('#save-account').click()
  await expect(form).toBeHidden()

  const saved = (await savedAccounts()).find((candidate) => candidate.id === 'acc-two')
  expect(saved).toMatchObject({ startAsleep: true, microphone: 'allow', camera: 'block' })
  expect(await webContentsIdFor(electronApp, 'acc-two')).not.toBeNull()

  await page.locator('#account-list .edit-account').nth(1).click()
  await expect(form.locator('input[name="startAsleep"]')).toBeChecked()
  await expect(form.locator('select[name="microphone"]')).toHaveValue('allow')
  await expect(form.locator('select[name="camera"]')).toHaveValue('block')
})

// Starting asleep is about the next start. An account just added is one the operator means to sign
// in to now – asleep, it would have no page and so no code to scan – so it comes up awake, with the
// box kept for the starts to come.
test('an account added with Start asleep ticked comes up awake', async () => {
  await launch()
  await expect(channel('acc-two')).toHaveAttribute('aria-selected', 'true')
  const form = page.locator('#account-dialog')

  await page.locator('#add-account').dispatchEvent('click')
  await form.locator('input[name="name"]').fill('Account four')
  await form.locator('input[name="startAsleep"]').check()
  await page.locator('#save-account').click()
  await expect(form).toBeHidden()

  await expect(page.locator('.channel')).toHaveCount(4)
  const added = (await savedAccounts()).find((candidate) => candidate.name === 'Account four')
  expect(added).toMatchObject({ startAsleep: true })
  await expect.poll(() => webContentsIdFor(electronApp, added.id)).not.toBeNull()
  await expect(channel(added.id)).not.toHaveClass(/\basleep\b/)
})
