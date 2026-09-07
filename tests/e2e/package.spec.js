import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtemp, rm, access } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'

const EXE = path.resolve('dist/win-unpacked/M-HUB.exe')

// The package exists only after `npm run dist` – without it the test has nothing to check.
let built = true
try {
  await access(EXE)
} catch {
  built = false
}

const BLOCKED_BY_SAC =
  'Smart App Control blocked this package. Measured 2026-08-24: SAC lets an unsigned file ' +
  'through only on a reputation verdict from the Defender cloud, and a FRESHLY BUILT one has ' +
  'none – the block needs no Mark of the Web. The installer is built on a CI runner, where ' +
  'SAC is not active; locally, run the sources with npm start.'

// The probe has to run BEFORE electron.launch: Playwright reports every failed attempt as
// a bare "Process failed to launch!" with no reason from the system, and test.skip() called
// from a catch block does NOT mark the test skipped – measured, it ends up red.
// On a Code Integrity refusal, a Node spawn returns errno UNKNOWN (not ENOENT, not EACCES).
function blockedByCodeIntegrity(dataDir) {
  const probe = spawnSync(EXE, [`--user-data-dir=${dataDir}`], { timeout: 2500 })
  return /UNKNOWN/i.test(String(probe.error?.code ?? ''))
}

test('the packaged application starts with a working renderer and IPC bridge', async () => {
  // The skip condition has to sit INSIDE the test – at file level Playwright reads
  // test.skip(condition, description) as a declaration of a skipped test, not as a condition.
  test.skip(!built, 'no dist/win-unpacked – run npm run dist first')

  const dataDir = await mkdtemp(path.join(tmpdir(), 'mhub-package-'))

  // This test used to skip on a REGISTRY READ ALONE ("SAC is on, so it will surely block"),
  // which is a guess. It now skips on a MEASURED attempt to launch.
  test.skip(blockedByCodeIntegrity(dataDir), BLOCKED_BY_SAC)

  const electronApp = await electron.launch({
    executablePath: EXE,
    args: [`--user-data-dir=${dataDir}`],
  })
  const page = await electronApp.firstWindow()
  await page.waitForSelector('body[data-ready="1"]')

  // These are exactly the places where a package can drift from the sources: asar, ESM in
  // the main process, and a CommonJS preload.
  expect(await page.title()).toBe('M-HUB')
  await expect(page.locator('#add-account')).toBeVisible()
  expect(await page.evaluate(() => window.mHub.listAccounts())).toEqual([])

  await page.keyboard.press('Control+Semicolon')
  await expect(page.locator('#macros-dialog')).toBeVisible()
  await page.locator('#macros-dialog button[value="close"]').click()

  // Regression from 2026-08-24: with an account loaded, dialogs hid underneath the native
  // account view. We check it on the PACKAGE, because the sources may already be fixed while
  // the shipped package is still the old one.
  await page.locator('#add-account').click()
  await page.locator('#account-dialog input[name="name"]').fill('Messenger')
  await page.locator('#account-dialog select[name="platform"]').selectOption('messenger')
  await page.locator('#save-account').click()
  await expect(page.locator('.channel')).toHaveCount(1)

  await page.locator('#add-account').click()
  await expect(page.locator('#account-dialog')).toBeVisible()
  await expect
    .poll(() =>
      electronApp.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].contentView.children.filter((w) => w.getVisible()).length,
      ),
    )
    .toBe(0)

  await page.locator('#account-dialog button[value="cancel"]').click()
  await expect(page.locator('#account-dialog')).toBeHidden()

  // The nameplate on the PACKAGE carries what CI put into the manifest – a build date and a
  // commit – and this is the only place it can be seen to have arrived: the sources cannot
  // know either, and say so instead.
  await page.locator('#open-settings').click()
  await expect(page.locator('#about-built')).toHaveText(/^\d{4}-\d{2}-\d{2} · [0-9a-f]{7}$/)
  await page.locator('#close-settings').click()

  await electronApp.close()
  const cleanup = rm(dataDir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
  await Promise.race([cleanup, new Promise((done) => setTimeout(done, 3000))])
})
