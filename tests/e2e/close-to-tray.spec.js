import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

let dataDir
let electronApp
let page

async function launch(layout) {
  if (layout) await writeFile(path.join(dataDir, 'layout.json'), JSON.stringify(layout), 'utf8')
  electronApp = await electron.launch({ args: ['.', `--user-data-dir=${dataDir}`] })
  page = await electronApp.firstWindow()
  await page.waitForSelector('body[data-ready="1"]')
}

const closeWindow = () =>
  electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())

const windowIsVisible = () =>
  electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible() ?? null)

test.beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'mhub-tray-'))
})

test.afterEach(async () => {
  await electronApp.close().catch(() => {})
  const cleanup = rm(dataDir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
  await Promise.race([cleanup, new Promise((done) => setTimeout(done, 3000))])
})

// The window button ending the process is the wrong default for an app whose job is to sit
// there and notice things. Everything the operator is signed into would have to load again.
test('the window button puts the app in the tray instead of ending it', async () => {
  await launch()

  await closeWindow()

  await expect.poll(windowIsVisible).toBe(false)
  // Still alive: the window object exists, so nothing was torn down.
  expect(await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1)
})

test('the layout is written on the way to the tray, not only on the way out', async () => {
  await launch()
  await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ x: 60, y: 70, width: 1000, height: 700 }))

  await closeWindow()
  await expect.poll(windowIsVisible).toBe(false)

  const saved = JSON.parse(await (await import('node:fs/promises')).readFile(path.join(dataDir, 'layout.json'), 'utf8'))
  expect(saved.width).toBe(1000)
  expect(saved.closeToTray).toBe(true)
})

test('turning the setting off gives the window button back its usual meaning', async () => {
  await launch({ width: 1280, height: 800, closeToTray: false })

  const exited = new Promise((resolve) => electronApp.process().once('exit', resolve))
  await closeWindow()

  await expect(exited).resolves.toBeDefined()
})

// Settings is where the switch has to be reachable, and it has to show the state the main
// process is actually in rather than a default painted into the HTML.
test('Settings shows the switch and turning it off is remembered', async () => {
  await launch()

  await page.locator('#open-settings').click()
  await expect(page.locator('#close-to-tray')).toBeChecked()

  await page.locator('#close-to-tray').uncheck()
  await page.locator('#close-settings').click()

  // The switch is saved by the main process after an IPC call, as a write and a rename, so the
  // file can still be on its way when the dialog has closed – measured on CI, run 38994251448,
  // ENOENT on a read made straight after the click. What is asked is whether it gets written.
  const savedCloseToTray = () =>
    readFile(path.join(dataDir, 'layout.json'), 'utf8').then((text) => JSON.parse(text).closeToTray, () => null)
  await expect.poll(savedCloseToTray).toBe(false)

  const exited = new Promise((resolve) => electronApp.process().once('exit', resolve))
  await closeWindow()
  await expect(exited).resolves.toBeDefined()
})
