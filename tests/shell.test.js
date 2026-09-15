import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { loadLayout, saveLayout, centreOn, setAutoStart, isAutoStartOn, acceptHoverReport, DEFAULT_LAYOUT } from '../src/main/shell.js'

let file, dir

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'mhub-layout-'))
  file = path.join(dir, 'layout.json')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('the window layout', () => {
  test('a missing file yields the default layout', async () => {
    expect(await loadLayout(file)).toEqual(DEFAULT_LAYOUT)
  })

  // Language is a preference rather than geometry, but it lives in the same settings
  // file – otherwise the first launch after installation would have to read two.
  test('the default language after installation is English', async () => {
    expect(DEFAULT_LAYOUT.language).toBe('en')
    expect((await loadLayout(file)).language).toBe('en')
  })

  test('a saved language survives a restart', async () => {
    await saveLayout(file, { ...DEFAULT_LAYOUT, language: 'pl' })
    expect((await loadLayout(file)).language).toBe('pl')
  })

  test('a damaged language value does not sink the start', async () => {
    await writeFile(file, JSON.stringify({ ...DEFAULT_LAYOUT, language: { zly: 'ksztalt' } }), 'utf8')
    expect(typeof (await loadLayout(file)).language).toBe('string')
  })

  // Version 1 kept this file under a Polish name. Reading the old one keeps the window
  // position across the upgrade, but leaving it behind would be worse than untidy: it is a
  // stale copy that would silently come back to life if the new file were ever lost.
  test('saving under the new name discards the legacy file it superseded', async () => {
    const legacy = path.join(dir, 'uklad.json')
    await writeFile(legacy, JSON.stringify({ szerokosc: 999, jezyk: 'pl' }), 'utf8')

    await saveLayout(file, { ...DEFAULT_LAYOUT }, legacy)

    expect(existsSync(legacy)).toBe(false)
    expect(existsSync(file)).toBe(true)
  })

  test('a legacy file that is already gone is not an error', async () => {
    await expect(saveLayout(file, { ...DEFAULT_LAYOUT }, path.join(dir, 'nie-ma.json'))).resolves.toBeUndefined()
  })

  test('the layout survives a save and a read', async () => {
    await saveLayout(file, { x: 100, y: 50, width: 1000, height: 700, maximized: false })
    const result = await loadLayout(file)
    expect(result.width).toBe(1000)
    expect(result.x).toBe(100)
  })

  test('a damaged file yields the default layout instead of an exception', async () => {
    await writeFile(file, 'nie-json', 'utf8')
    expect(await loadLayout(file)).toEqual(DEFAULT_LAYOUT)
  })

  test('absurd sizes are clamped to the minimum', async () => {
    await saveLayout(file, { width: 10, height: 10, maximized: false })
    const result = await loadLayout(file)
    expect(result.width).toBeGreaterThanOrEqual(800)
    expect(result.height).toBeGreaterThanOrEqual(600)
  })
})

describe('the pinned rail inside the layout', () => {
  test('a missing file leaves the rail unpinned, that is, collapsible', async () => {
    expect((await loadLayout(file)).railPinned).toBe(false)
  })

  test('a saved pin comes back on read', async () => {
    await saveLayout(file, { ...DEFAULT_LAYOUT, railPinned: true })

    expect((await loadLayout(file)).railPinned).toBe(true)
  })

  test('garbage in the field does not leak into state, a boolean always comes out', async () => {
    await saveLayout(file, { ...DEFAULT_LAYOUT, railPinned: 'tak' })

    expect((await loadLayout(file)).railPinned).toBe(true)
  })
})

describe('acceptHoverReport', () => {
  const report = (overrides) => ({
    hovered: false,
    pointerStillInside: false,
    windowFocused: true,
    ...overrides,
  })

  test('the pointer entering the rail is always worth acting on', () => {
    expect(acceptHoverReport(report({ hovered: true, windowFocused: false }))).toBe(true)
  })

  test('the pointer leaving while the window is focused collapses the rail', () => {
    expect(acceptHoverReport(report({ pointerStillInside: false }))).toBe(true)
  })

  // The artefact this exists for: another window took the foreground, the pointer never
  // moved, and Chromium reported a leave from a position still inside the rail.
  test('a leave reported from inside the rail by an unfocused window is ignored', () => {
    expect(acceptHoverReport(report({ pointerStillInside: true, windowFocused: false }))).toBe(false)
  })

  // Opening a modal dialog also produces a leave from inside the rail. That one is real –
  // the window still has the foreground – and swallowing it would leave the rail stuck open.
  test('a leave reported from inside the rail by the focused window still counts', () => {
    expect(acceptHoverReport(report({ pointerStillInside: true, windowFocused: true }))).toBe(true)
  })

  // The pointer genuinely left while the window was in the background: nothing spurious
  // about it, and the rail must not be left open on a stale hover.
  test('a leave from outside the rail counts even with the window in the background', () => {
    expect(acceptHoverReport(report({ pointerStillInside: false, windowFocused: false }))).toBe(true)
  })
})

describe('autostart', () => {
  const calls = []
  const fakeApp = { setLoginItemSettings: (settings) => calls.push(settings) }

  // openAsHidden is documented by Electron as macOS-only and deprecated. On Windows it does
  // nothing at all, so the app that was supposed to slip into the tray at login came up in
  // front of whatever the operator was doing, every morning. The Windows way is to pass a
  // flag on the command line and honour it at startup.
  test('a hidden start is asked for the way Windows understands', () => {
    calls.length = 0

    setAutoStart(true, fakeApp)

    expect(calls).toHaveLength(1)
    expect(calls[0].openAtLogin).toBe(true)
    expect(calls[0].args).toEqual(['--hidden'])
    expect(calls[0]).not.toHaveProperty('openAsHidden')
  })

  test('turning it off turns it off', () => {
    calls.length = 0

    setAutoStart(false, fakeApp)

    expect(calls[0].openAtLogin).toBe(false)
  })

  // The Windows side of Electron as measured on 43.4.1: openAtLogin is true only for an entry
  // that matches the arguments asked about, and executableWillLaunchAtLogin ignores the
  // arguments but not an entry marked disabled. Writing an entry clears that mark. Written
  // against this rather than against a list of calls, so the tick is tested for agreeing with
  // what setAutoStart writes, whatever either of them passes.
  function windowsLoginItems() {
    let entry = null
    let disabled = false
    return {
      setLoginItemSettings: ({ openAtLogin, args = [] }) => {
        entry = openAtLogin ? { args } : null
        disabled = false
      },
      getLoginItemSettings: ({ args = [] } = {}) => ({
        openAtLogin: entry !== null && JSON.stringify(entry.args) === JSON.stringify(args),
        executableWillLaunchAtLogin: entry !== null && !disabled,
      }),
      disableInTaskManager: () => {
        if (entry) disabled = true
      },
    }
  }

  // Read without --hidden, the entry setAutoStart wrote did not count, so the tick in the tray
  // came back empty after every restart and a click on it switched autostart on again.
  test('the tick agrees with what switching it on wrote', () => {
    const app = windowsLoginItems()

    setAutoStart(true, app)

    expect(isAutoStartOn(app)).toBe(true)
  })

  test('the tick agrees with what switching it off wrote', () => {
    const app = windowsLoginItems()
    setAutoStart(true, app)

    setAutoStart(false, app)

    expect(isAutoStartOn(app)).toBe(false)
  })

  // Task Manager leaves the entry in place and only marks it disabled, so the entry alone would
  // keep the tick on for a start that Windows is going to skip.
  test('an entry switched off in Task Manager leaves the tick empty until it is switched on again', () => {
    const app = windowsLoginItems()
    setAutoStart(true, app)
    app.disableInTaskManager()

    expect(isAutoStartOn(app)).toBe(false)

    setAutoStart(true, app)

    expect(isAutoStartOn(app)).toBe(true)
  })
})

describe('closing to the tray inside the layout', () => {
  // The app exists to sit in the tray and notice things, so that is the default. The tray
  // menu keeps a Quit item, and this switch is in Settings for anyone who wants the window
  // button to mean what it usually means.
  test('a fresh profile closes to the tray', () => {
    expect(DEFAULT_LAYOUT.closeToTray).toBe(true)
  })

  test('the choice survives a restart', async () => {
    const file = path.join(dir, 'layout.json')
    await saveLayout(file, { ...DEFAULT_LAYOUT, closeToTray: false })

    expect((await loadLayout(file)).closeToTray).toBe(false)
  })

  test('a layout file written before this setting existed still closes to the tray', async () => {
    const file = path.join(dir, 'layout.json')
    await writeFile(file, JSON.stringify({ width: 1000, height: 700 }), 'utf8')

    expect((await loadLayout(file)).closeToTray).toBe(true)
  })
})

describe('where downloads go, inside the layout', () => {
  // Asking is what Electron does when no save path is set, so this default changes nothing
  // about how the application already behaves – it only puts the behaviour somewhere it can
  // be turned off.
  test('a fresh profile asks where to save', () => {
    expect(DEFAULT_LAYOUT.askWhereToSave).toBe(true)
  })

  // Empty, and resolved to the system Downloads folder when a download starts. Writing the
  // resolved path here would put a machine-specific path into a file that travels.
  test('a fresh profile names no folder of its own', () => {
    expect(DEFAULT_LAYOUT.downloadDir).toBe('')
  })

  test('both choices survive a restart', async () => {
    const file = path.join(dir, 'layout.json')
    await saveLayout(file, { ...DEFAULT_LAYOUT, askWhereToSave: false, downloadDir: 'D:\Praca' })

    const layout = await loadLayout(file)
    expect(layout.askWhereToSave).toBe(false)
    expect(layout.downloadDir).toBe('D:\Praca')
  })

  // Absent is not the same as off – the same rule closeToTray had to learn.
  test('a layout file written before these settings existed still asks', async () => {
    const file = path.join(dir, 'layout.json')
    await writeFile(file, JSON.stringify({ width: 1000, height: 700 }), 'utf8')

    const layout = await loadLayout(file)
    expect(layout.askWhereToSave).toBe(true)
    expect(layout.downloadDir).toBe('')
  })

  // A damaged file must not reach the save dialog as an object or a number.
  test('a folder that is not a string is no folder at all', async () => {
    const file = path.join(dir, 'layout.json')
    await writeFile(file, JSON.stringify({ downloadDir: { where: 'D:\Praca' } }), 'utf8')

    expect((await loadLayout(file)).downloadDir).toBe('')
  })
})

// Where the window opens is no longer a stored fact but a computed one. A remembered position
// is only valid for the monitor arrangement it was written on, and arrangements change:
// measured on 2026-09-01, a layout carrying x=-1394 y=972 put the window on a screen the
// operator was not looking at, and the size stored beside it – 1347x795 – was wider than the
// laptop's own work area. Both halves have to be answered, or centring alone would place an
// oversized window with its title bar above the top edge.
describe('centring the window on the primary monitor', () => {
  const workArea = (x, y, width, height) => ({ x, y, width, height })

  test('a window smaller than the screen is centred in the work area', () => {
    expect(centreOn(workArea(0, 0, 1920, 1032), { width: 1280, height: 752 })).toEqual({
      x: 320,
      y: 140,
      width: 1280,
      height: 752,
    })
  })

  // The work area, not the whole screen: the taskbar is not somewhere a window may sit.
  test('a taskbar down the side shifts the centre with it', () => {
    expect(centreOn(workArea(80, 0, 1840, 1080), { width: 1280, height: 752 })).toEqual({
      x: 360,
      y: 164,
      width: 1280,
      height: 752,
    })
  })

  // A monitor that is not the leftmost has an origin of its own, and one placed to the left of
  // the primary has a NEGATIVE origin – the arrangement measured on this machine.
  test('the origin of the monitor is carried into the result', () => {
    expect(centreOn(workArea(-1680, 644, 1680, 990), { width: 1280, height: 752 })).toEqual({
      x: -1480,
      y: 763,
      width: 1280,
      height: 752,
    })
  })

  // Remembered from a larger monitor. Centring a window bigger than the screen would put its
  // top edge – and with it the title bar and the close button – out of reach.
  test('a window larger than the screen is cut down to it, not centred beyond it', () => {
    expect(centreOn(workArea(0, 0, 1280, 752), { width: 1347, height: 795 })).toEqual({
      x: 0,
      y: 0,
      width: 1280,
      height: 752,
    })
  })
})
