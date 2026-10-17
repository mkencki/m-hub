import { createServer } from 'node:http'

// Shared preconditions. Everything here exists because a test assumed a starting state
// instead of establishing one, and then failed for a reason that had nothing to do with what
// it was testing.

// The status bar can already be carrying something the application said at startup – most
// often that another program owns the global macro shortcut, which is a system-wide exclusive
// and, during a full suite run, is sometimes still held by the previous spec's application on
// its way out. A test about a message raised by the action under test has to start from an
// empty bar, and the bar is emptied the way the operator would empty it.
export async function clearStatusBar(page) {
  const bar = page.locator('#message')
  if (await bar.isVisible()) await page.locator('#dismiss-message').click()
  await bar.waitFor({ state: 'hidden' })
}

// Puts every account view on a blank document, in an order Chromium cannot resolve the wrong
// way round.
//
// The obvious version – stop() the real page, then loadURL('about:blank') over it – is a
// RACE, and two specs already carried comments saying so and calling it fixed. It was not.
// Measured 2026-08-26 over six full suite runs: navigation.spec.js failed in FOUR of them,
// always the same way, with the real page landing on top of the replacement:
//
//     Expected: "about:blank"   Received: "https://www.messenger.com/"
//
// stop() cancels the load that is in flight. A navigation Chromium has already handed on to
// commit is no longer in flight, and nothing cancels that one – it arrives last and wins.
//
// So nothing is replaced while it is still moving. Waiting for the pending navigation to
// COMMIT (did-navigate) or give up (did-fail-load) leaves nothing that could still land, and
// the replacement is then the only navigation there is.
//
// The question and the subscription sit in the same synchronous block on purpose: the main
// process runs one thing at a time, so no navigation can commit between asking whether one is
// pending and asking to be told when it finishes. Split by an await, that gap is the same
// race again, one layer down.
export const blankTheViews = (electronApp) =>
  electronApp.evaluate(async ({ BrowserWindow }) => {
    // The question is whether the main frame has COMMITTED anything yet, and the answer is
    // the URL – not isLoadingMainFrame(). Measured 2026-08-26 on the two views of
    // notification-routing.spec.js: the second had already committed the real page and still
    // reported isLoadingMainFrame() true while it finished fetching what the page asked for.
    // No second did-navigate was ever coming, so waiting for one waited until the test timed
    // out. An empty URL is the only state where a first commit is still on its way.
    const committed = (webContents) => {
      if (webContents.getURL()) return Promise.resolve()
      return new Promise((landed) => {
        webContents.once('did-navigate', landed)
        webContents.once('did-fail-load', landed)
      })
    }

    for (const view of BrowserWindow.getAllWindows()[0].contentView.children) {
      await committed(view.webContents)
      // A rejection here is ERR_ABORTED and it is the point, not a problem: about:blank
      // aborts whatever the real page was still fetching. Its navigation has already landed,
      // so it cannot land again on top of this one.
      await view.webContents.loadURL('about:blank').catch(() => {})
    }
  })

// The application's own window, by id. BrowserWindow.getAllWindows() puts the NEWEST window
// first – measured in rail.spec.js, where opening a second window moved the application's own
// to index 1 – so [0] stops meaning the application the moment a test, or a page asking for a
// sign-in popup, opens another one. Ask right after launch, before anything else can open.
export const appWindowId = (electronApp) =>
  electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].id)

// The webContents id of an account's view, found by its session rather than by its place among
// the window's children. The place stops meaning anything once a view can be closed and made
// again: a recreated view is added at the end, so children[n] would be the n-th view that
// happens to exist, not the n-th account. The partition is the one thing no two accounts share.
//
// An id and not the view, because only plain values cross evaluate(); a test reaches the view
// again with webContents.fromId(id). A view that is closed and recreated has a new id, so ask
// again after anything that may have done that. Null when the account has no view at all.
//
// Only the windows' CHILD views are searched. A sign-in popup is a window of its own whose page
// shares the account's session, and it is not the account's view.
export const webContentsIdFor = (electronApp, accountId) =>
  electronApp.evaluate(({ BrowserWindow, session }, id) => {
    const wanted = session.fromPartition(`persist:${id}`)
    for (const window of BrowserWindow.getAllWindows()) {
      const view = window.contentView.children.find((child) => child.webContents?.session === wanted)
      if (view) return view.webContents.id
    }
    return null
  }, accountId)

// Sends a key the way a real one arrives, so before-input-event sees it. Playwright's keyboard
// goes in through the debugger and never reaches that interceptor – measured while writing
// channel-shortcuts.spec.js, where it saw nothing at all – so a shortcut handled in the main
// process and tested with page.keyboard passes whether it works or not.
//
// The target is a webContents id: the application window's own
// (BrowserWindow.fromId(appWindowId).webContents.id) or an account view's (webContentsIdFor).
//
// Focus is not taken unless asked for. Electron documents that sendInputEvent needs the window
// holding the contents to be focused; on a CI runner it is, because the window under test is the
// only one there is. Taking it on purpose is exactly what must not happen on a desktop somebody
// is using, so it is a choice each test makes in the open, not a side effect of every key press.
// What focus: true moves is keyboard focus to that webContents, as a click into it would.
export const pressKey = (electronApp, webContentsId, keyCode, modifiers = [], { focus = false } = {}) =>
  electronApp.evaluate(
    ({ webContents }, { id, keyCode, modifiers, focus }) => {
      const target = webContents.fromId(id)
      if (focus) target.focus()
      target.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
      target.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
    },
    { id: webContentsId, keyCode, modifiers, focus },
  )

// Native menus are drawn by Windows, outside anything Playwright sees or can click, and a real
// one left open waits for a click that never comes – on a runner, or on the desktop of whoever
// started the run. So a menu is caught on its way out: popup() records it instead of showing it,
// and the test picks an item by id from the main process.
//
// Replacing the method on the prototype reaches every menu the application builds, because
// popup() is a JavaScript method of Electron's Menu class. The tray menu is not affected: it is
// handed to the tray with setContextMenu and never popped up.
export const captureMenus = (electronApp) =>
  electronApp.evaluate(({ Menu }) => {
    globalThis.__capturedMenus = []
    Menu.prototype.popup = function (options = {}) {
      globalThis.__capturedMenus.push({ menu: this, options })
    }
  })

// What the last captured menu offered, as plain values an assertion can compare.
export const lastMenu = (electronApp) =>
  electronApp.evaluate(() => {
    const last = globalThis.__capturedMenus?.at(-1)
    if (!last) return null
    const describe = (menu) =>
      menu.items.map((item) => ({
        id: item.id,
        label: item.label,
        enabled: item.enabled,
        ...(item.submenu ? { submenu: describe(item.submenu) } : {}),
      }))
    return describe(last.menu)
  })

// Clicks an item of the last captured menu by id. item.click() is what a real click calls –
// it flips a checkbox and runs the item's handler with the window the menu was popped up for –
// and then the menu's close callback runs, as it does when a real menu closes after a click.
// An id that is not there throws, because a click that silently does nothing would make the
// test wait for an effect that was never asked for.
export const clickMenuItem = (electronApp, itemId) =>
  electronApp.evaluate(({ BrowserWindow }, id) => {
    const last = globalThis.__capturedMenus?.at(-1)
    if (!last) throw new Error('no menu has been popped up')
    const item = last.menu.getMenuItemById(id)
    if (!item) throw new Error(`the last menu has no item "${id}"`)
    const window = last.options.window ?? BrowserWindow.getFocusedWindow() ?? undefined
    item.click(undefined, window, window?.webContents)
    last.options.callback?.()
  }, itemId)

// Serves the given pages from a local port, for whatever a test needs an account view to hold: a
// history to step through, a page guarding an unsaved draft. A real service would put the test on
// the network and inside somebody's account. Each key is a path, each value the HTML served there.
//
// Load them with loadURL from the main process, never by following a link. 127.0.0.1 is none of
// any platform's hosts, so a link followed inside an account view is classified as external and
// handed to shell.openExternal – the system browser, on whatever machine is running the test.
export async function servePages(pages) {
  const server = createServer((request, response) => {
    const page = pages[new URL(request.url, 'http://127.0.0.1').pathname]
    if (page === undefined) {
      response.writeHead(404).end()
      return
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(page)
  })
  await new Promise((listening) => server.listen(0, '127.0.0.1', listening))
  return {
    url: (pathname) => `http://127.0.0.1:${server.address().port}${pathname}`,
    // A connection Chromium still holds would keep close() waiting, so every one is ended first.
    close: () => {
      server.closeAllConnections()
      return new Promise((closed) => server.close(closed))
    },
  }
}

