// Which key means what, decided apart from Electron so the decision can be examined without a
// running application. main.js attaches the interceptor and carries the commands out; this file
// only names them. Every key handled here arrives through before-input-event, on the application
// window and on every account view alike – see attachShortcuts in main.js for why both.
//
// The commands:
//   'reload'       the account being looked at, the ordinary way
//   'hard-reload'  the same, past the HTTP cache and the service worker
//   'back'         one step back in the history of the account being looked at
//   'forward'      one step forward in it
//   'devtools'     the developer tools of the account being looked at
//   { select: n }  the n-th account on the rail, counted from zero
//   'macros'       the macro palette
//   null           not ours – the key goes on to the page
//
// A window a page opened for itself – inChildWindow – is asked about too. There the commands act
// on that window, and only the ones that make sense for a page on its own are given: it has no
// rail to pick an account from, and a macro would land in the account view behind it.

const noOtherModifier = (input, ...allowed) =>
  ['control', 'shift', 'alt', 'meta'].every((name) => allowed.includes(name) || !input[name])

const STEPS = { ArrowLeft: 'back', ArrowRight: 'forward' }

export function commandFor(input, { inMainWindow = false, inChildWindow = false } = {}) {
  if (input?.type !== 'keyDown') return null
  const name = String(input.key ?? '')
  const letter = name.toLowerCase()

  if (name === 'F12' || (input.control && input.shift && letter === 'i')) return 'devtools'

  // What every browser on Windows does with Alt and an arrow. A held key would race past the
  // pages the operator meant to stop at, each repeat starting a navigation over the one before
  // it, so only the press counts. The keyboard's own Back and Forward keys are not here on
  // purpose: Windows reports them twice, once as a key and once as app-command, and main.js
  // answers app-command alone.
  if (Object.hasOwn(STEPS, name) && input.alt && noOtherModifier(input, 'alt')) {
    return input.isAutoRepeat ? null : STEPS[name]
  }

  // Chromium's own pairing of keys and reloads: F5 and Ctrl+R are the ordinary reload, and the
  // same keys with Ctrl or Shift added skip the cache. A held key repeats about thirty times a
  // second, and every repeat would abort the reload the one before it had just started, so only
  // the first press counts.
  const reloadKey =
    (name === 'F5' && !input.alt && !input.meta) || (letter === 'r' && input.control && !input.alt && !input.meta)
  if (reloadKey) {
    if (input.isAutoRepeat) return null
    const hard = name === 'F5' ? input.control || input.shift : input.shift
    return hard ? 'hard-reload' : 'reload'
  }

  if (inChildWindow) return null

  if (input.control && noOtherModifier(input, 'control') && /^[1-9]$/.test(name)) {
    return { select: Number(name) - 1 }
  }

  // In the application window Ctrl+; belongs to the renderer's own listener. Claimed here too,
  // the palette would open twice.
  if (input.control && name === ';' && !inMainWindow) return 'macros'

  return null
}
