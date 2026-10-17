import { describe, test, expect } from 'vitest'
import { classify, hostClass } from '../src/main/navigation.js'
import { PLATFORMS } from '../src/main/accounts.js'

// The shape a platform declares. The real ones live in accounts.js; these are here so the
// rules can be read next to the cases that exercise them.
const messenger = {
  hosts: ['messenger.com', 'facebook.com', 'meta.com'],
  authHosts: [],
  external: ['l.facebook.com', 'lm.facebook.com', 'www.facebook.com/l.php'],
}

const withApple = { hosts: ['linkedin.com'], authHosts: ['appleid.apple.com'], external: [] }

describe('classify', () => {
  test('the service itself stays in the account view', () => {
    expect(classify(messenger, 'https://www.messenger.com/t/12345')).toBe('view')
    expect(classify(messenger, 'https://messenger.com/')).toBe('view')
  })

  test('a link out of a conversation goes to the system browser', () => {
    expect(classify(messenger, 'https://example.org/article')).toBe('external')
  })

  // eTLD+1 matching gives the opposite of the intended answer here, which is the entire
  // reason host matching is a suffix comparison ON A DOT BOUNDARY and never a substring.
  test('a host that merely ends with the service name is a stranger', () => {
    expect(classify(messenger, 'https://facebook.com.example.invalid/login')).toBe('external')
    expect(classify(messenger, 'https://notfacebook.com/')).toBe('external')
  })

  // Meta wraps outgoing links so that every one of them looks like a facebook.com URL. The
  // external list is therefore consulted BEFORE the host list, or the wrapper would keep
  // the whole web inside the account view.
  test('a link shim is a link out, however much it looks like the service', () => {
    expect(classify(messenger, 'https://l.facebook.com/l.php?u=https%3A%2F%2Fexample.org')).toBe('external')
    expect(classify(messenger, 'https://lm.facebook.com/l.php?u=x')).toBe('external')
    expect(classify(messenger, 'https://www.facebook.com/l.php?u=x')).toBe('external')
  })

  test('the service host is still itself on paths the shim does not own', () => {
    expect(classify(messenger, 'https://www.facebook.com/marketplace')).toBe('view')
  })

  // Nothing but a page fetched over http or https is ever handed to the system, because
  // shell.openExternal will happily launch whatever the operating system associates with a
  // scheme it does not recognise.
  test('anything that is not a web page at all is refused outright', () => {
    expect(classify(messenger, 'javascript:alert(1)')).toBe('block')
    expect(classify(messenger, 'file:///C:/Windows/System32/calc.exe')).toBe('block')
    expect(classify(messenger, 'data:text/html,<h1>hi')).toBe('block')
    expect(classify(messenger, 'ms-msdt:/id')).toBe('block')
  })

  test('something that is not a URL at all is refused rather than guessed at', () => {
    expect(classify(messenger, 'not a url')).toBe('block')
    expect(classify(messenger, '')).toBe('block')
    expect(classify(messenger, undefined)).toBe('block')
  })

  // The same address means different things depending on how it was reached. Following a
  // link keeps it in the view; a page ASKING for a window gets a window, because that is
  // what sign-in flows do and they talk back to the opener.
  test('a window the page opens on its own host becomes a controlled child window', () => {
    expect(classify(messenger, 'https://www.messenger.com/login', { viaWindowOpen: true })).toBe('child')
  })

  // Apple's sign-in answers through postMessage to whoever opened it, so it cannot be
  // pushed out to the system browser and cannot be silently denied either.
  test('a declared sign-in host is allowed a child window', () => {
    expect(
      classify(withApple, 'https://appleid.apple.com/auth/authorize?response_mode=web_message', {
        viaWindowOpen: true,
      }),
    ).toBe('child')
  })

  test('a stranger asking for a window still only gets the system browser', () => {
    expect(classify(messenger, 'https://example.org/', { viaWindowOpen: true })).toBe('external')
  })

  test('a link shim asking for a window is still a link out', () => {
    expect(classify(messenger, 'https://l.facebook.com/l.php?u=x', { viaWindowOpen: true })).toBe('external')
  })

  test('a sign-in host reached by following a link stays in the view', () => {
    expect(classify(withApple, 'https://appleid.apple.com/auth/authorize')).toBe('view')
  })

  test('a platform that declares nothing sends everything to the browser', () => {
    expect(classify({}, 'https://example.org/')).toBe('external')
    expect(classify(undefined, 'https://example.org/')).toBe('external')
  })
})

// The cases above use stand-in platforms so the rules can be read beside them. This one uses
// the REAL LinkedIn entry, because what failed on 2026-08-30 was the declaration, not the rule.
//
// "Sign in with Microsoft" was pushed to the system browser and answered with
//   AADSTS900561: The endpoint only accepts POST requests. Received a GET request.
// shell.openExternal can only ever issue a GET, and this flow is POST: the authorize call
// carries response_mode=form_post. So an undeclared host does not merely open in the wrong
// place – it arrives stripped of its method and cannot work at all.
//
// Both addresses below were measured, not guessed: login.live.com by following the button on
// linkedin.com/login, and login.microsoft.com from the error screen the operator hit at the
// passkey step.
describe('the hosts LinkedIn sign-in really visits', () => {
  test('a Microsoft account sign-in is kept inside the application', () => {
    expect(
      classify(
        PLATFORMS.linkedin,
        'https://login.live.com/oauth20_authorize.srf?client_id=3fa91358-6f74-4525-b5df-da149652be36&response_mode=form_post&tenant=consumers',
        { viaWindowOpen: true },
      ),
    ).toBe('child')
  })

  test('the passkey step of that sign-in is kept inside the application too', () => {
    expect(
      classify(PLATFORMS.linkedin, 'https://login.microsoft.com/consumers/fido/get?mkt=EN-US&lc=1033&uiflavor=web', {
        viaWindowOpen: true,
      }),
    ).toBe('child')
  })

  // The allowlist is an allowlist. A host that merely looks Microsoft-ish is still a stranger.
  test('a lookalike host is still sent to the system browser', () => {
    expect(classify(PLATFORMS.linkedin, 'https://login.live.com.example.invalid/', { viaWindowOpen: true })).toBe('external')
  })
})

// What a window a page asked for is, written to the log in place of its address. Whether
// redirecting popups into the account view is worth building rests on how many of them are
// sign-ins and how many are articles – and disposition cannot tell those two apart, which is
// how this file came to exist. The class can, and it names no person and no page.
describe('hostClass', () => {
  test('a host of the service is the service', () => {
    expect(hostClass(messenger, 'https://www.facebook.com/photo/?fbid=1')).toBe('service')
  })

  test('a sign-in host declared for the platform is a sign-in', () => {
    expect(hostClass(withApple, 'https://appleid.apple.com/auth/authorize')).toBe('auth')
  })

  // The wrapper sits on the service's own host, so it is told apart before the host list is read.
  test('a link wrapper is a wrapper, though it sits on the service host', () => {
    expect(hostClass(messenger, 'https://l.facebook.com/l.php?u=https%3A%2F%2Fexample.org')).toBe('shim')
    expect(hostClass(messenger, 'https://www.facebook.com/l.php?u=https%3A%2F%2Fexample.org')).toBe('shim')
  })

  test('anywhere else is external', () => {
    expect(hostClass(messenger, 'https://example.org/article')).toBe('external')
  })

  test('what is not a web address at all is blocked', () => {
    expect(hostClass(messenger, 'ms-settings:privacy')).toBe('block')
    expect(hostClass(messenger, 'not a url')).toBe('block')
  })

  // classify is the decision and hostClass the description; they must never disagree.
  test('the class decides the verdict', () => {
    const verdicts = { service: 'child', auth: 'child', shim: 'external', external: 'external', block: 'block' }
    for (const [platform, address] of [
      [messenger, 'https://www.messenger.com/t/1'],
      [withApple, 'https://appleid.apple.com/'],
      [messenger, 'https://lm.facebook.com/l.php?u=x'],
      [messenger, 'https://example.org/'],
      [messenger, 'file:///C:/Windows/'],
    ]) {
      expect(classify(platform, address, { viaWindowOpen: true })).toBe(verdicts[hostClass(platform, address)])
    }
  })
})
