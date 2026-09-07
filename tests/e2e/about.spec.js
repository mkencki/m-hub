import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

let dataDir
let electronApp
let page

test.beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'mhub-about-'))
  electronApp = await electron.launch({ args: ['.', `--user-data-dir=${dataDir}`] })
  page = await electronApp.firstWindow()
  await page.waitForSelector('body[data-ready="1"]')
  await page.locator('#open-settings').click()
  await expect(page.locator('#settings-dialog')).toBeVisible()
})

test.afterEach(async () => {
  await electronApp.close().catch(() => {})
  const cleanup = rm(dataDir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
  await Promise.race([cleanup, new Promise((done) => setTimeout(done, 3000))])
})

test('the nameplate carries the version from the manifest', async () => {
  const { version } = JSON.parse(await readFile('package.json', 'utf8'))
  await expect(page.locator('#about-version')).toHaveText(version)
})

// The sources have no build date. Showing the date they were last touched would be a guess
// dressed as a fact, so a run from the sources says what it is instead.
test('a run from the sources says so instead of showing a build date', async () => {
  await expect(page.locator('#about-built')).toHaveText('running from source')
})

test('the engine row reports the Electron and Chromium this process actually runs on', async () => {
  const versions = await electronApp.evaluate(() => process.versions)
  await expect(page.locator('#about-engine')).toHaveText(`Electron ${versions.electron} · Chromium ${versions.chrome}`)
})

test('the profile row shows the profile directory and how much it holds', async () => {
  await expect(page.locator('#about-profile')).toHaveText(path.resolve(dataDir))
  // A fresh profile is small, and the walk lands after the dialog is open – hence a wait.
  await expect(page.locator('#about-profile-size')).toHaveText(/^\d+([.,]\d)? (B|KB|MB) on disk$/)
})

// The renderer names neither the folder nor the address – both are the main process's own
// choice, for the same reason "Show in folder" is given an id rather than a path. So the test
// stands in for the system and records what it was handed.
test('the buttons hand the profile folder and the repository address to the system', async () => {
  await electronApp.evaluate(({ shell }) => {
    globalThis.handedToSystem = []
    shell.openPath = async (target) => {
      globalThis.handedToSystem.push(['path', target])
      return ''
    }
    shell.openExternal = async (url) => {
      globalThis.handedToSystem.push(['url', url])
    }
  })

  await page.locator('#open-profile').click()
  await page.locator('#open-repository').click()

  await expect.poll(() => electronApp.evaluate(() => globalThis.handedToSystem)).toEqual([
    ['path', path.resolve(dataDir)],
    ['url', 'https://github.com/mkencki/m-hub'],
  ])
})

test('the nameplate speaks Polish when the interface does', async () => {
  await page.locator('#language-select').selectOption('pl')

  await expect(page.locator('#about [data-i18n="aboutProfile"]')).toHaveText('Profil')
  await expect(page.locator('#about-built')).toHaveText('uruchomiona ze źródeł')
  await expect(page.locator('#about-profile-size')).toHaveText(/ na dysku$/)
})
