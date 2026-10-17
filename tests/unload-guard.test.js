import { describe, test, expect } from 'vitest'
import { UnloadGuard } from '../src/main/unload-guard.js'

// A page with an unsent draft can refuse to be left, and in a WebContentsView Electron turns
// that refusal into silence: no dialog, no error, the reload or the navigation simply does not
// happen. The guard is what lets the application say so and offer to go ahead – without ever
// going ahead with something the operator did not just ask for.

const clockAt = (start = 0) => {
  let now = start
  return { now: () => now, advance: (ms) => (now += ms) }
}

describe('a refusal right after the application asked for something', () => {
  test('names what was refused', () => {
    const guard = new UnloadGuard()
    guard.arm('acc-a', 'reload')
    expect(guard.blocked('acc-a')).toBe('reload')
  })

  test('going ahead hands that action back once and lets the next refusal through', () => {
    const guard = new UnloadGuard()
    guard.arm('acc-a', 'hard-reload')
    guard.blocked('acc-a')

    expect(guard.proceed('acc-a')).toBe('hard-reload')
    expect(guard.proceed('acc-a')).toBeNull()
    expect(guard.allowed('acc-a')).toBe(true)
    expect(guard.allowed('acc-a')).toBe(false)
  })
})

describe('a refusal nobody here asked for', () => {
  // Measured in the research for this change: the page's own navigations and the mouse's back
  // button are refused the same way, and neither passes through the application. Offering
  // "go ahead" for those would replay whatever the application last did instead.
  test('names nothing when nothing was asked for', () => {
    expect(new UnloadGuard().blocked('acc-a')).toBeNull()
  })

  test('names nothing when the request is stale', () => {
    const clock = clockAt()
    const guard = new UnloadGuard({ now: clock.now })
    guard.arm('acc-a', 'reload')
    clock.advance(6000)
    expect(guard.blocked('acc-a')).toBeNull()
  })

  test('a request is spent by the refusal it caused', () => {
    const guard = new UnloadGuard()
    guard.arm('acc-a', 'reload')
    guard.blocked('acc-a')
    expect(guard.blocked('acc-a')).toBeNull()
  })

  test('going ahead with nothing refused does nothing', () => {
    const guard = new UnloadGuard()
    expect(guard.proceed('acc-a')).toBeNull()
    expect(guard.allowed('acc-a')).toBe(false)
  })
})

describe('the permission to leave a draft behind', () => {
  // The permission is for the action being repeated at that moment. Left standing, it would let
  // a later navigation – the page's own, minutes on – throw away a draft without a word.
  test('runs out', () => {
    const clock = clockAt()
    const guard = new UnloadGuard({ now: clock.now })
    guard.arm('acc-a', 'reload')
    guard.blocked('acc-a')
    guard.proceed('acc-a')
    clock.advance(16000)
    expect(guard.allowed('acc-a')).toBe(false)
  })

  test('belongs to one account', () => {
    const guard = new UnloadGuard()
    guard.arm('acc-a', 'reload')
    guard.blocked('acc-a')
    guard.proceed('acc-a')
    expect(guard.allowed('acc-b')).toBe(false)
    expect(guard.allowed('acc-a')).toBe(true)
  })
})

test('a newer request replaces an older one for the same account', () => {
  const guard = new UnloadGuard()
  guard.arm('acc-a', 'reload')
  guard.arm('acc-a', 'hard-reload')
  expect(guard.blocked('acc-a')).toBe('hard-reload')
})
