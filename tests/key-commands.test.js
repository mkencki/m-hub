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
