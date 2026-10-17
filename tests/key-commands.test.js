import { describe, test, expect } from 'vitest'
import { commandFor } from '../src/main/key-commands.js'

// What before-input-event hands over, with every modifier written out, so a case cannot pass
// only because a flag it never set happened to be undefined.
const key = (name, modifiers = {}) => ({
  type: 'keyDown',
  key: name,
  control: false,
  shift: false,
  alt: false,
  meta: false,
  isAutoRepeat: false,
  ...modifiers,
})

const inView = { inMainWindow: false }
const inWindow = { inMainWindow: true }
const inChildWindow = { inChildWindow: true }

describe('reloading', () => {
  // Electron binds no key to F5 and the application has no menu, so until now F5 did nothing
  // anywhere – the key everybody reaches for when a page has gone white.
  test('F5 reloads', () => {
    expect(commandFor(key('F5'), inView)).toBe('reload')
    expect(commandFor(key('F5'), inWindow)).toBe('reload')
  })

  test('Ctrl+R reloads, as it did', () => {
    expect(commandFor(key('r', { control: true }), inView)).toBe('reload')
    expect(commandFor(key('r', { control: true }), inWindow)).toBe('reload')
  })

  // Chromium's own pairing: the modified keys bypass the cache and the service worker. That
  // is the variant for a page that keeps coming back broken from what it saved.
  test('Ctrl+F5, Shift+F5 and Ctrl+Shift+R reload past the cache', () => {
    expect(commandFor(key('F5', { control: true }), inView)).toBe('hard-reload')
    expect(commandFor(key('F5', { shift: true }), inView)).toBe('hard-reload')
    expect(commandFor(key('R', { control: true, shift: true }), inView)).toBe('hard-reload')
  })

  // A held key repeats about thirty times a second, and every repeat would abort the reload the
  // previous one had just started.
  test('a held key reloads once, not once per repeat', () => {
    expect(commandFor(key('F5', { isAutoRepeat: true }), inView)).toBeNull()
    expect(commandFor(key('r', { control: true, isAutoRepeat: true }), inView)).toBeNull()
  })

  test('Alt+F5 and Ctrl+Alt+R are not reloads', () => {
    expect(commandFor(key('F5', { alt: true }), inView)).toBeNull()
    expect(commandFor(key('r', { control: true, alt: true }), inView)).toBeNull()
  })
})

describe('going back and forward', () => {
  // The mouse's side buttons already step through an account's history – Chromium does that on
  // its own – but a touchpad, the touch screen and the keyboard had no way at all. Alt+Left and
  // Alt+Right are what every browser on Windows uses.
  test('Alt+Left goes back and Alt+Right goes forward', () => {
    expect(commandFor(key('ArrowLeft', { alt: true }), inView)).toBe('back')
    expect(commandFor(key('ArrowRight', { alt: true }), inView)).toBe('forward')
    expect(commandFor(key('ArrowLeft', { alt: true }), inWindow)).toBe('back')
    expect(commandFor(key('ArrowRight', { alt: true }), inWindow)).toBe('forward')
  })

  // A bare arrow moves the caret in the composer, and the arrows with Ctrl or Shift added select
  // words – Alt+Shift+Left among them in some editors. Only the plain Alt chord is a step.
  test('arrows without Alt, or with anything else added, are left to the page', () => {
    expect(commandFor(key('ArrowLeft'), inView)).toBeNull()
    expect(commandFor(key('ArrowLeft', { alt: true, shift: true }), inView)).toBeNull()
    expect(commandFor(key('ArrowLeft', { alt: true, control: true }), inView)).toBeNull()
    expect(commandFor(key('ArrowRight', { alt: true, meta: true }), inView)).toBeNull()
  })

  // A key held a moment too long would race past the pages the operator meant to stop at, each
  // repeat starting a navigation over the one before it. One press, one step.
  test('a held Alt+Left steps once, not once per repeat', () => {
    expect(commandFor(key('ArrowLeft', { alt: true, isAutoRepeat: true }), inView)).toBeNull()
  })

  // Windows turns the keyboard's own Back key into WM_APPCOMMAND, which the window reports as
  // app-command, AND hands it to before-input-event as BrowserBack – measured while researching
  // this change. Answered in both places it would go back two steps, so it is answered in
  // app-command only, which is also the one place that hears it whatever holds the focus.
  test('the Browser Back and Browser Forward keys are not handled here', () => {
    expect(commandFor(key('BrowserBack'), inView)).toBeNull()
    expect(commandFor(key('BrowserForward'), inView)).toBeNull()
    expect(commandFor(key('BrowserBack'), inWindow)).toBeNull()
  })
})

// A window a page opened for itself – a sign-in, a link opened in a new window – is a small
// browser of its own, with its own history. It gets the keys that act on the page in front of the
// operator, and none of the ones that act on the application.
describe('in a window a page opened', () => {
  test('Alt+Left and Alt+Right step through that window', () => {
    expect(commandFor(key('ArrowLeft', { alt: true }), inChildWindow)).toBe('back')
    expect(commandFor(key('ArrowRight', { alt: true }), inChildWindow)).toBe('forward')
  })

  test('F5, Ctrl+F5 and F12 act on that window', () => {
    expect(commandFor(key('F5'), inChildWindow)).toBe('reload')
    expect(commandFor(key('F5', { control: true }), inChildWindow)).toBe('hard-reload')
    expect(commandFor(key('F12'), inChildWindow)).toBe('devtools')
  })

  // Ctrl+1..9 picks an account on a rail this window does not have, and a macro is inserted into
  // the account view behind it, not into the page the operator is looking at.
  test('the keys that belong to the application are left alone', () => {
    expect(commandFor(key('1', { control: true }), inChildWindow)).toBeNull()
    expect(commandFor(key(';', { control: true }), inChildWindow)).toBeNull()
  })
})

describe('what was there before stays as it was', () => {
  test('F12 and Ctrl+Shift+I open the developer tools', () => {
    expect(commandFor(key('F12'), inView)).toBe('devtools')
    expect(commandFor(key('I', { control: true, shift: true }), inWindow)).toBe('devtools')
  })

  test('Ctrl+1 to Ctrl+9 pick an account by its place on the rail', () => {
    expect(commandFor(key('1', { control: true }), inView)).toEqual({ select: 0 })
    expect(commandFor(key('9', { control: true }), inWindow)).toEqual({ select: 8 })
  })

  test('Ctrl+0 and Ctrl+Shift+1 pick nothing', () => {
    expect(commandFor(key('0', { control: true }), inView)).toBeNull()
    expect(commandFor(key('1', { control: true, shift: true }), inView)).toBeNull()
  })

  // In the application's own window Ctrl+; belongs to the renderer, which listens for it on
  // window. Claimed here as well, it would open the palette twice – and taken away from the
  // renderer, it would stop working there without one test noticing, because every test of it
  // in the window presses the key through Playwright, which never reaches this interceptor.
  test('Ctrl+; is claimed only when it lands in an account view', () => {
    expect(commandFor(key(';', { control: true }), inView)).toBe('macros')
    expect(commandFor(key(';', { control: true }), inWindow)).toBeNull()
  })
})

describe('everything else passes through', () => {
  test('a key release is not a command', () => {
    expect(commandFor({ ...key('F5'), type: 'keyUp' }, inView)).toBeNull()
  })

  test('ordinary typing is left to the page', () => {
    expect(commandFor(key('r'), inView)).toBeNull()
    expect(commandFor(key('Enter'), inView)).toBeNull()
    expect(commandFor(key('F4'), inView)).toBeNull()
  })
})
