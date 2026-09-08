import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

// Its own profile, like every other spec here. Without one this test borrows the operator's:
// it launched with no --user-data-dir, took the default profile, and from the moment a single
// instance lock existed it failed whenever msg-hub happened to be running on the machine –
// the second copy quits on purpose, and Playwright reports an application that would not
// start. Measured 2026-08-25, with the operator's own window open at the time.
test('the app starts and opens exactly one window', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'mhub-startup-'))
  const electronApp = await electron.launch({ args: ['.', `--user-data-dir=${dataDir}`] })

  // A window with no content loaded is not a page as far as Playwright is concerned, so
  // firstWindow() would wait forever. The state is read from the main process instead.
  const titles = await electronApp.evaluate(async ({ app, BrowserWindow }) => {
    await app.whenReady()
    for (let probe = 0; probe < 50 && BrowserWindow.getAllWindows().length === 0; probe += 1) {
      await new Promise((done) => setTimeout(done, 100))
    }
    return BrowserWindow.getAllWindows().map((page) => page.getTitle())
  })

  expect(titles).toEqual(['M-HUB'])

  await electronApp.close()
  const cleanup = rm(dataDir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
  await Promise.race([cleanup, new Promise((done) => setTimeout(done, 3000))])
})

// A quit that arrives while the application is still starting. Measured on CI on 2026-09-07
// (run 34166392686, this very spec): Playwright's close() reached the main process while
// createWindow was awaiting the accounts file, the window closed and was destroyed, and
// createWindow carried on regardless – "TypeError: Object has been destroyed" at fitViews, as
// an unhandled rejection on stderr. The exit happened to survive it that time; an exception in
// the main process is also how an exit has been blocked before (see settings.spec.js).
//
// The quit is asked for from inside the main process the moment the window is created, which
// is the earliest anybody can ask for it. launch() resolves after app.whenReady() and before
// createWindow has built the window – measured three times out of three on 2026-09-08, so the
// listener is always in place in time.
test('a quit that arrives during startup ends the process without an exception', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'mhub-startup-'))
  const electronApp = await electron.launch({ args: ['.', `--user-data-dir=${dataDir}`] })
  const stderr = []
  electronApp.process().stderr.on('data', (chunk) => stderr.push(String(chunk)))
  const exited = new Promise((resolve) => electronApp.process().once('exit', (code) => resolve(code)))

  const askedFor = await electronApp.evaluate(({ app, BrowserWindow }) => {
    if (BrowserWindow.getAllWindows().length) {
      app.quit()
      return 'with the window already there'
    }
    app.on('browser-window-created', () => app.quit())
    return 'as the window was created'
  })

  const exit = await Promise.race([exited, new Promise((over) => setTimeout(() => over('still running'), 10000))])
  if (exit === 'still running') electronApp.process().kill()

  expect(exit, `quit asked for ${askedFor}`).toBe(0)
  expect(stderr.join('')).not.toMatch(/Object has been destroyed|UnhandledPromiseRejection|Uncaught Exception/)

  await electronApp.close().catch(() => {})
  const cleanup = rm(dataDir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
  await Promise.race([cleanup, new Promise((done) => setTimeout(done, 3000))])
})

// The same quit, a moment later: while the renderer is being loaded into the window. Electron
// then rejects loadFile with ERR_FAILED, and it does so BEFORE the window reports itself
// destroyed – measured 2026-09-08 in the full suite, four times per run, as unhandled
// rejections from tests that close the application soon after it has a window. The trigger
// here is the first load the main window starts, which is that file.
test('a quit that arrives while the renderer is loading ends the process without an exception', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'mhub-startup-'))
  const electronApp = await electron.launch({ args: ['.', `--user-data-dir=${dataDir}`] })
  const stderr = []
  electronApp.process().stderr.on('data', (chunk) => stderr.push(String(chunk)))
  const exited = new Promise((resolve) => electronApp.process().once('exit', (code) => resolve(code)))

  await electronApp.evaluate(({ app }) => {
    app.on('web-contents-created', (_event, contents) => {
      contents.once('did-start-loading', () => app.quit())
    })
  })

  const exit = await Promise.race([exited, new Promise((over) => setTimeout(() => over('still running'), 10000))])
  if (exit === 'still running') electronApp.process().kill()

  expect(exit).toBe(0)
  expect(stderr.join('')).not.toMatch(/Object has been destroyed|UnhandledPromiseRejection|Uncaught Exception|ERR_FAILED/)

  await electronApp.close().catch(() => {})
  const cleanup = rm(dataDir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
  await Promise.race([cleanup, new Promise((done) => setTimeout(done, 3000))])
})
