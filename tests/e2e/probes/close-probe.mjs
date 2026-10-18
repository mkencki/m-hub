// What closing an account's view does in Electron 43.4.1, measured in a bare Electron process with
// nothing attached to it. Putting an account to sleep closes its view, and two things nobody had
// measured decide how: whether a close reports anything the application would announce as a crash,
// a hang or a failed load, and whether close({ waitForBeforeUnload: true }) lets a page holding a
// draft refuse in a WebContentsView, as the typings promise.
//
// Not measured inside the application under Playwright, for one of the two: Playwright is attached
// to every page over the DevTools protocol and takes a real beforeunload for a dialog of its own
// (run 38990782830). Here no debugger is attached, so a refusal is Electron's own answer.
//
// Run by view-close.spec.js, which reads the one line this prints. The pages come from a local
// server; nothing here touches a real service or a real profile.
import { app, BrowserWindow, WebContentsView } from 'electron'
import { createServer } from 'node:http'

const SETTLE_MS = 3000
const SW_TAIL_MS = 45000

const PAGES = {
  '/plain': '<!doctype html><title>plain</title><p>plain</p>',
  '/guard': `<!doctype html><title>guard</title><p>guard</p>
<script>addEventListener('beforeunload', (event) => { event.preventDefault(); event.returnValue = 'draft' })</script>`,
  '/sw': `<!doctype html><title>sw</title><p>sw</p>
<script>
navigator.serviceWorker.register('/sw.js')
navigator.serviceWorker.ready.then(() => {
  const done = () => { document.title = 'sw-ready' }
  if (navigator.serviceWorker.controller) done()
  else navigator.serviceWorker.addEventListener('controllerchange', done)
})
</script>`,
}
const WORKER = `self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))
self.addEventListener('fetch', () => {})`

const results = { cases: {} }
let finished = false
const finish = () => {
  if (finished) return
  finished = true
  process.stdout.write(`CLOSE-PROBE ${JSON.stringify(results)}\n`)
  app.exit(0)
}
setTimeout(() => {
  results.timedOut = true
  finish()
}, 100000)

const wait = (ms) => new Promise((done) => setTimeout(done, ms))

const server = createServer((request, response) => {
  const pathname = new URL(request.url, 'http://127.0.0.1').pathname
  if (pathname === '/slow') return // never answered: a load that is still on its way when the view closes
  if (pathname === '/sw.js') {
    response.writeHead(200, { 'content-type': 'text/javascript' })
    response.end(WORKER)
    return
  }
  const page = PAGES[pathname]
  if (page === undefined) {
    response.writeHead(404).end()
    return
  }
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  response.end(page)
})

let window
let counter = 0
let base

// A view as the application makes one, recording everything it reports from here on with the time
// since the close was asked for.
function makeView({ hidden = false, partition } = {}) {
  counter += 1
  const view = new WebContentsView({
    webPreferences: {
      partition: partition ?? `persist:probe-${counter}`,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  })
  window.contentView.addChildView(view)
  view.setBounds({ x: 0, y: 0, width: 600, height: hidden ? 0 : 400 })
  const record = { events: [], closedAt: null }
  const since = () => (record.closedAt === null ? null : Date.now() - record.closedAt)
  const contents = view.webContents
  contents.on('render-process-gone', (_event, details) =>
    record.events.push({ name: 'render-process-gone', reason: details.reason, ms: since() }),
  )
  contents.on('unresponsive', () => record.events.push({ name: 'unresponsive', ms: since() }))
  contents.on('did-fail-load', (_event, code, _description, url, isMainFrame) =>
    record.events.push({ name: 'did-fail-load', code, isMainFrame, url, ms: since() }),
  )
  contents.on('did-fail-provisional-load', (_event, code, _description, url, isMainFrame) =>
    record.events.push({ name: 'did-fail-provisional-load', code, isMainFrame, url, ms: since() }),
  )
  contents.on('will-prevent-unload', () => record.events.push({ name: 'will-prevent-unload', ms: since() }))
  contents.on('destroyed', () => record.events.push({ name: 'destroyed', ms: since() }))
  return { view, contents, record }
}

const load = (contents, pathname) =>
  new Promise((loaded) => {
    contents.once('did-stop-loading', loaded)
    contents.loadURL(base + pathname).catch(() => {})
  })

// Closes the view and gives it time to report whatever it is going to report.
async function closeAndWatch({ view, contents, record }, options) {
  record.closedAt = Date.now()
  if (options === undefined) contents.close()
  else contents.close(options)
  await wait(SETTLE_MS)
  record.destroyed = contents.isDestroyed()
  record.url = record.destroyed ? null : contents.getURL()
  if (!record.destroyed) {
    // The page refused. Taken down for good so it does not outlive the probe.
    window.contentView.removeChildView(view)
    contents.close()
  } else {
    window.contentView.removeChildView(view)
  }
  return record
}

async function plainCase(name, { page = '/plain', hidden = false, options, overrideRefusal = false } = {}) {
  const made = makeView({ hidden })
  await load(made.contents, page)
  if (overrideRefusal) made.contents.on('will-prevent-unload', (event) => event.preventDefault())
  results.cases[name] = await closeAndWatch(made, options)
}

// A load still on its way when the view closes – an account put to sleep while its page is loading.
async function loadingCase() {
  const made = makeView()
  await load(made.contents, '/plain')
  made.contents.loadURL(base + '/slow').catch(() => {})
  await wait(300)
  results.cases['close-while-loading'] = await closeAndWatch(made)
}

const metricsHave = (pid) => app.getAppMetrics().some((entry) => entry.pid === pid)

// A page with a running service worker, closed and woken on the same partition straight away – while
// the worker still holds the old process, which earlier probes measured at about 28.5 seconds.
async function serviceWorkerCase() {
  const record = { events: [] }
  results.cases['service-worker-wake'] = record
  const partition = 'persist:probe-sw'
  const first = makeView({ partition })
  const ready = new Promise((done) => {
    first.contents.on('page-title-updated', (_event, title) => {
      if (title === 'sw-ready') done(true)
    })
    setTimeout(() => done(false), 15000)
  })
  first.contents.loadURL(base + '/sw').catch(() => {})
  record.workerReady = await ready
  record.oldPid = first.contents.getOSProcessId()

  first.record.closedAt = Date.now()
  const destroyed = new Promise((done) => first.contents.once('destroyed', done))
  first.contents.close()
  await destroyed
  window.contentView.removeChildView(first.view)
  record.closeEvents = first.record.events
  record.oldAliveAfterClose = metricsHave(record.oldPid)

  const wokeAt = Date.now()
  const second = makeView({ partition })
  await load(second.contents, '/sw')
  record.wakeMs = Date.now() - wokeAt
  record.newPid = second.contents.getOSProcessId()
  record.samePid = record.newPid === record.oldPid
  record.oldAliveAfterWake = metricsHave(record.oldPid)

  const start = Date.now()
  while (metricsHave(record.oldPid) && Date.now() - start < SW_TAIL_MS) await wait(500)
  record.oldGoneAfterCloseMs = metricsHave(record.oldPid) ? null : Date.now() - first.record.closedAt
  record.newStillAlive = !second.contents.isDestroyed() && metricsHave(record.newPid)
  record.newEvents = second.record.events
  window.contentView.removeChildView(second.view)
  second.contents.close()
}

app.whenReady().then(async () => {
  await new Promise((listening) => server.listen(0, '127.0.0.1', listening))
  base = `http://127.0.0.1:${server.address().port}`
  window = new BrowserWindow({ width: 640, height: 480, show: true })
  results.versions = { electron: process.versions.electron, chrome: process.versions.chrome }
  try {
    await plainCase('close')
    await plainCase('close-hidden', { hidden: true })
    await plainCase('wait-plain', { options: { waitForBeforeUnload: true } })
    await plainCase('wait-guard', { page: '/guard', options: { waitForBeforeUnload: true } })
    await plainCase('wait-guard-hidden', { page: '/guard', hidden: true, options: { waitForBeforeUnload: true } })
    await plainCase('wait-guard-overridden', {
      page: '/guard',
      options: { waitForBeforeUnload: true },
      overrideRefusal: true,
    })
    await plainCase('close-guard', { page: '/guard' })
    await loadingCase()
    await serviceWorkerCase()
  } catch (error) {
    results.error = String(error?.stack ?? error)
  }
  finish()
})
