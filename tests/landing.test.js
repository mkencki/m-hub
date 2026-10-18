import { describe, test, expect } from 'vitest'
import { EventEmitter } from 'node:events'
import { loadAndLand } from '../src/main/landing.js'

const ADDRESS = 'https://www.facebook.com/some.page/posts/1'
const LEFT = 'https://www.facebook.com/'
const EVENTS = ['did-navigate', 'did-navigate-in-page', 'did-fail-load', 'did-stop-loading', 'destroyed']

const ABORTED = -3

// What Electron's loadURL answers when it fails: the first failure the main frame reported, whichever
// page it was about.
const failed = (code, url) => () =>
  Promise.reject(Object.assign(new Error(`(${code}) loading '${url}'`), { errno: code, url }))

// A webContents as far as a load is concerned: it reports what Electron would, in the order a test
// gives, from inside loadURL – where the first reports of a real load can already arrive – and
// answers with the promise Electron's loadURL would.
function contentsReporting(during = () => {}, answer = () => Promise.resolve()) {
  const contents = new EventEmitter()
  contents.loads = []
  contents.loadURL = (address) => {
    contents.loads.push(address)
    const answered = answer(contents)
    during(contents)
    return answered
  }
  return contents
}

// The promise of a load that has not been reported on yet: it settles with the commit.
const afterCommit = (contents) => new Promise((done) => contents.once('did-navigate', () => done()))

const commit = (contents, url = ADDRESS) => contents.emit('did-navigate', {}, url, 200, 'OK')
const fail = (contents, code, url, isMainFrame = true) => contents.emit('did-fail-load', {}, code, '', url, isMainFrame)

// Whether the answer is still to come after everything already queued has run – a whole turn of the
// event loop, since an answer can be a few promise steps away.
const pending = async (promise) => {
  let settled = false
  promise.then(
    () => (settled = true),
    () => (settled = true),
  )
  await new Promise((turn) => setTimeout(turn, 0))
  return !settled
}

describe('loading a page and knowing whether it got there', () => {
  test('starts the load of the address it is given', () => {
    const contents = contentsReporting()
    loadAndLand(contents, ADDRESS)
    expect(contents.loads).toEqual([ADDRESS])
  })

  test('answers yes once the page has committed', async () => {
    const contents = contentsReporting(commit)
    expect(await loadAndLand(contents, ADDRESS)).toBe(true)
  })

  test('a redirect still lands: the page committed is the one the address led to', async () => {
    const contents = contentsReporting((c) => commit(c, 'https://www.facebook.com/photo/?fbid=1'))
    expect(await loadAndLand(contents, ADDRESS)).toBe(true)
  })

  // The case this exists for. The page being left reports its own unfinished load as aborted – at
  // once, or only after the new page is in (measured on CI, run 39074653622) – and loadURL's
  // promise fails on it, though the address got where it was sent.
  test('the page being left reporting its load cut short is no failure of this one', async () => {
    const contents = contentsReporting(
      (c) => {
        fail(c, ABORTED, LEFT)
        commit(c)
      },
      failed(ABORTED, LEFT),
    )
    expect(await loadAndLand(contents, ADDRESS)).toBe(true)
  })

  test('nor does that report end the wait for the page still on its way', async () => {
    const contents = contentsReporting((c) => fail(c, ABORTED, LEFT), failed(ABORTED, LEFT))
    const landing = loadAndLand(contents, ADDRESS)
    expect(await pending(landing)).toBe(true)
    commit(contents)
    expect(await landing).toBe(true)
  })

  // A page holding an unsent draft refuses to be left, and Electron reports the refusal as an
  // abort of the very address that was asked for.
  test('answers no when the page refuses to be left', async () => {
    const contents = contentsReporting((c) => fail(c, ABORTED, ADDRESS), failed(ABORTED, ADDRESS))
    expect(await loadAndLand(contents, ADDRESS)).toBe(false)
  })

  test('answers no when an error page stands in for the address', async () => {
    const contents = contentsReporting((c) => fail(c, -105, ADDRESS), failed(-105, ADDRESS))
    expect(await loadAndLand(contents, ADDRESS)).toBe(false)
  })

  test('answers no when the redirect the address led to fails', async () => {
    const redirect = 'https://www.facebook.com/photo/?fbid=1'
    const contents = contentsReporting((c) => fail(c, -105, redirect), failed(-105, redirect))
    expect(await loadAndLand(contents, ADDRESS)).toBe(false)
  })

  test('answers no when loading stops without a page committed', async () => {
    const contents = contentsReporting((c) => c.emit('did-stop-loading', {}), failed(-2, ADDRESS))
    expect(await loadAndLand(contents, ADDRESS)).toBe(false)
  })

  test('answers no when the webContents goes away on the way', async () => {
    const contents = contentsReporting((c) => c.emit('destroyed', {}), failed(-2, ADDRESS))
    expect(await loadAndLand(contents, ADDRESS)).toBe(false)
  })

  test('a frame inside the page failing decides nothing', async () => {
    const contents = contentsReporting((c) => fail(c, -105, 'https://ads.example.com/', false), afterCommit)
    const landing = loadAndLand(contents, ADDRESS)
    expect(await pending(landing)).toBe(true)
    commit(contents)
    expect(await landing).toBe(true)
  })

  // An address that differs from the page in front only after the # is reached within the page.
  test('a step within the page to that very address lands', async () => {
    const contents = contentsReporting((c) => c.emit('did-navigate-in-page', {}, ADDRESS, true))
    expect(await loadAndLand(contents, ADDRESS)).toBe(true)
  })

  // The page in front rewriting its own address while the new one is on its way is not the arrival
  // of the new one.
  test('the page in front stepping within itself elsewhere decides nothing', async () => {
    const contents = contentsReporting((c) => c.emit('did-navigate-in-page', {}, `${LEFT}?sk=h_chr`, true))
    expect(await pending(loadAndLand(contents, ADDRESS))).toBe(true)
  })

  test('stops listening once it has answered', async () => {
    const contents = contentsReporting(commit)
    await loadAndLand(contents, ADDRESS)
    for (const name of EVENTS) expect(contents.listenerCount(name)).toBe(0)
  })

  test('a later report changes nothing once it has answered', async () => {
    const contents = contentsReporting((c) => {
      commit(c)
      fail(c, -105, ADDRESS)
    })
    expect(await loadAndLand(contents, ADDRESS)).toBe(true)
  })
})
