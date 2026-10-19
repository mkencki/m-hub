import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

// A profile written on a desk with external monitors, opened on a desk without them. Measured
// on 2026-09-01: a layout carrying x=-1394 y=972 put the window where no screen was, and a
// later one put it on a second monitor the operator was not looking at. Either way the
// application was running and unreachable – the window is what the application IS.
//
// The position in the fixture is deliberately absurd. It is not a place any monitor could be,
// so if the window turns up inside the work area the position was not the thing that decided.
test('a position remembered from another desk does not put the window off the screen', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'mhub-placement-'))
  await writeFile(
    path.join(dataDir, 'layout.json'),
    JSON.stringify({ x: -9999, y: -9999, width: 1280, height: 752, maximized: false }),
    'utf8',
  )

  const electronApp = await electron.launch({ args: ['.', `--user-data-dir=${dataDir}`] })

  const placement = await electronApp.evaluate(async ({ app, BrowserWindow, screen }) => {
    await app.whenReady()
    for (let probe = 0; probe < 50 && BrowserWindow.getAllWindows().length === 0; probe += 1) {
      await new Promise((done) => setTimeout(done, 100))
    }
    const window = BrowserWindow.getAllWindows()[0]
    return { bounds: window.getBounds(), workArea: screen.getPrimaryDisplay().workArea }
  })

  const { bounds, workArea } = placement
  expect(bounds.x).toBeGreaterThanOrEqual(workArea.x)
  expect(bounds.y).toBeGreaterThanOrEqual(workArea.y)
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(workArea.x + workArea.width)
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(workArea.y + workArea.height)

  await electronApp.close()
  const cleanup = rm(dataDir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
  await Promise.race([cleanup, new Promise((done) => setTimeout(done, 3000))])
})

// The login item starts the application with --hidden, into the tray. A window remembered
// maximized was maximized right after it was built – and Electron shows a hidden window it is
// asked to maximize (NativeWindowViews::Maximize, Electron 43.4.1). So every login put the window
// on the screen after all, without the foreground, and the focus given to the account in front then
// asked Windows for it: the taskbar button flashed orange at a start meant to be silent.
test.describe('a start from the login item with the window remembered maximized', () => {
  let dataDir
  let electronApp

  test.beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'mhub-hidden-'))
    await writeFile(
      path.join(dataDir, 'layout.json'),
      JSON.stringify({ width: 1280, height: 752, maximized: true }),
      'utf8',
    )
    electronApp = await electron.launch({ args: ['.', `--user-data-dir=${dataDir}`, '--hidden'] })
    const page = await electronApp.firstWindow()
    // Ready means the start has run to its end, the account in front shown and focused included.
    await page.waitForSelector('body[data-ready="1"]')
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

  const windowState = () =>
    electronApp.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      return { visible: window.isVisible(), maximized: window.isMaximized() }
    })

  test('stays out of sight', async () => {
    expect((await windowState()).visible).toBe(false)
  })

  // A second launch is the operator asking to see the application, as the tray is.
  test('comes back maximized when asked for', async () => {
    await electronApp.evaluate(({ app }) => app.emit('second-instance'))

    await expect.poll(windowState).toEqual({ visible: true, maximized: true })
  })

  // Never shown, the window was never maximized either; what the operator chose is still that.
  test('quit without being seen, still remembers maximized', async () => {
    await electronApp.evaluate(({ app }) => app.quit())
    const closing = electronApp.close().then(() => 'closed', () => 'closed')
    await Promise.race([closing, new Promise((over) => setTimeout(over, 10000))])

    const saved = JSON.parse(await readFile(path.join(dataDir, 'layout.json'), 'utf8'))
    expect(saved.maximized).toBe(true)
  })
})
