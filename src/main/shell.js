import { readFile, writeFile, rename, unlink } from 'node:fs/promises'

export const DEFAULT_LAYOUT = {
  width: 1280,
  height: 800,
  maximized: false,
  // An unpinned rail collapses to icons and expands when the cursor enters it.
  railPinned: false,
  // The app exists to sit in the tray and notice things arriving, so the window button
  // puts it there rather than ending the process. The tray menu keeps a Quit item, and
  // Settings keeps a switch for anyone who wants the button to mean what it usually means.
  closeToTray: true,
  // Where files from the accounts go, and whether the operator is asked every time. Asking is
  // what Electron does when no save path is set, so this default changes nothing about how the
  // application already behaves – it only puts the behaviour where it can be turned off. The
  // folder is left empty rather than resolved: the system Downloads folder is worked out when
  // a download starts, so a layout file copied to another machine carries no path from this one.
  downloadDir: '',
  askWhereToSave: true,
  // English after installation – the app travels beyond one machine. The list of
  // languages and their validation live in src/renderer/i18n.js; only the stored
  // value lives here, so the main process does not drag the dictionaries with it.
  language: 'en',
}

// Where the window opens, worked out at every start instead of remembered.
//
// A stored position is only true for the monitor arrangement it was written on, and
// arrangements change: measured 2026-09-01 on this machine, a layout carrying x=-1394 y=972
// opened the window on a second screen the operator was not looking at, and an earlier one had
// put it off the desktop entirely. The primary monitor is the one the operator has told
// Windows to treat as theirs, so that is where the window belongs.
//
// The SIZE is clamped here too, and not as an afterthought. A window remembered from a large
// external monitor is wider than a laptop's work area, and centring something bigger than the
// screen puts its top edge – the title bar, the close button – beyond reach. Clamped first,
// then centred, the result is always somewhere the mouse can get to.
//
// workArea rather than bounds: the taskbar is not somewhere a window may sit. Its x and y are
// carried through because a monitor has an origin of its own, and one placed left of the
// primary has a negative one.
export function centreOn(workArea, { width, height }) {
  const fitted = {
    width: Math.min(width, workArea.width),
    height: Math.min(height, workArea.height),
  }
  return {
    x: workArea.x + Math.round((workArea.width - fitted.width) / 2),
    y: workArea.y + Math.round((workArea.height - fitted.height) / 2),
    ...fitted,
  }
}

// Passed by the login item and read back at startup – see setAutoStart.
export const HIDDEN_FLAG = '--hidden'

const MIN_WIDTH = 800
const MIN_HEIGHT = 600

// Schema version 1 wrote these keys in Polish and kept them in uklad.json.
// Both spellings are accepted on read so an upgrade does not throw away the window
// position, the pinned rail or – most visibly – the chosen language.
export async function loadLayout(filePath) {
  try {
    const data = JSON.parse(await readFile(filePath, 'utf8'))
    const width = Number(data.width ?? data.szerokosc)
    const height = Number(data.height ?? data.wysokosc)
    return {
      ...data,
      x: data.x,
      y: data.y,
      width: Math.max(MIN_WIDTH, width || DEFAULT_LAYOUT.width),
      height: Math.max(MIN_HEIGHT, height || DEFAULT_LAYOUT.height),
      maximized: Boolean(data.maximized ?? data.zmaksymalizowane),
      railPinned: Boolean(data.railPinned ?? data.szynaPrzypieta),
      // Absent in every layout file written before this setting existed, and absent is not
      // the same as off – those profiles get the default like a fresh one.
      closeToTray: data.closeToTray === undefined ? DEFAULT_LAYOUT.closeToTray : Boolean(data.closeToTray),
      // A string and nothing else, for the same reason as the language below: an object out of
      // a damaged file must never reach a save dialog as a starting folder.
      downloadDir: typeof data.downloadDir === 'string' ? data.downloadDir : DEFAULT_LAYOUT.downloadDir,
      askWhereToSave:
        data.askWhereToSave === undefined ? DEFAULT_LAYOUT.askWhereToSave : Boolean(data.askWhereToSave),
      // A string and nothing else. Whether such a language exists is decided by the
      // renderer through validLanguage() – an object or a number out of a damaged
      // file must never reach the interface.
      language: typeof (data.language ?? data.jezyk) === 'string' ? (data.language ?? data.jezyk) : DEFAULT_LAYOUT.language,
    }
  } catch {
    return { ...DEFAULT_LAYOUT }
  }
}

// legacyPath is the version 1 file, which lived under a Polish name. It is removed only
// AFTER the new file is safely in place: leaving it behind would be worse than untidy,
// because it is a stale copy that would silently come back to life if the new file were
// ever lost. A legacy file that is already gone is not an error.
export async function saveLayout(filePath, layout, legacyPath = null) {
  await writeFile(filePath + '.tmp', JSON.stringify(layout, null, 2), 'utf8')
  await rename(filePath + '.tmp', filePath)
  if (legacyPath && legacyPath !== filePath) {
    await unlink(legacyPath).catch(() => {})
  }
}

// openAsHidden is documented by Electron as macOS-only and deprecated; on Windows it does
// nothing, so an app told to start hidden at login came up in front of whatever the operator
// was doing, every morning. The Windows way is a flag on the command line, honoured when the
// window is built.
export function setAutoStart(enabled, app) {
  app.setLoginItemSettings({ openAtLogin: Boolean(enabled), args: [HIDDEN_FLAG] })
}

// Whether the tick beside Start with Windows belongs on. Electron compares the Run entry with
// the executable AND the arguments it is asked about, so the question has to carry the same
// --hidden that setAutoStart writes. Asked without it, it says no to its own entry – measured
// 2026-09-15 on Electron 43.4.1: straight after the write, openAtLogin was false without the
// arguments and true with them. In the tray that meant a tick that came back empty after every
// restart, and a click on it that switched autostart on again instead of off.
//
// openAtLogin still says yes to an entry switched off in Task Manager or Windows Settings. That
// switch is a disabled mark under StartupApproved, with the Run entry left where it is – Electron
// documents the mark as what those two screens show – and only executableWillLaunchAtLogin reads
// it. Measured the same day with the mark set by hand: the tick came up empty, and one click on
// it switched autostart on for real, because the write clears the mark.
export function isAutoStartOn(app) {
  const settings = app.getLoginItemSettings({ args: [HIDDEN_FLAG] })
  return Boolean(settings.openAtLogin && settings.executableWillLaunchAtLogin)
}

// A mouseleave on the channel rail does not always mean the pointer left it. Chromium fires
// one when the window stops being the foreground window, and it carries the position the
// pointer had all along – measured 2026-08-25 at clientX 24 inside a rail box of 0..162,
// with the cursor never moved. Acting on that shuts the rail under the cursor of someone
// who did nothing, and it stays shut when they come back, because coming back produces no
// fresh mouseenter.
//
// BOTH halves of the condition below are needed, and each covers the other's mistake.
// Position alone also swallows the genuine leave that opening a modal dialog produces,
// which fires with the pointer inside the rail too – and then the rail never closes again.
// Focus alone swallows every leave that arrives while another window happens to be in
// front, which on a busy machine is most of them.
export function acceptHoverReport({ hovered, pointerStillInside, windowFocused }) {
  if (hovered) return true
  return !(pointerStillInside && !windowFocused)
}
