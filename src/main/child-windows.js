// A window a page opened for itself – a sign-in, or a link the operator opened in a new window
// with a middle click or Ctrl+click. It is a small browser of its own, with a history of its own,
// and until now it had no way to move through it but the mouse's side buttons.
//
// It stays a window. Moving such links into the account view by the way they were opened was
// weighed and set aside: a sign-in popup and a link to an article cannot be told apart by
// disposition – measured while surveying LinkedIn's sign-ins – and a sign-in pulled into the view
// loses the window it answers to. So the window gets the keys and a menu instead, and the menu can
// move a page of the service itself into the account view when the operator asks for it.
//
// A plain template and a plain function, so what the window offers and what each item does can be
// examined without Electron; main.js builds the menu and attaches the clicks.

import { hostClass } from './navigation.js'
import { step } from './history.js'

export function childWindowMenuTemplate({ platform, url, canGoBack, canGoForward, tr }) {
  return [
    {
      id: 'page',
      label: tr('childMenuPage'),
      submenu: [
        // The keys are taken in before-input-event, like every other shortcut here. Registered by
        // the menu as well, the same key would be answered twice; shown, they teach the shortcut.
        { id: 'back', label: tr('navBack'), accelerator: 'Alt+Left', registerAccelerator: false, enabled: canGoBack },
        { id: 'forward', label: tr('navForward'), accelerator: 'Alt+Right', registerAccelerator: false, enabled: canGoForward },
        { id: 'reload', label: tr('reloadAccount'), accelerator: 'F5', registerAccelerator: false },
        { type: 'separator' },
        // Only a page of the service itself. A sign-in answers back to the window that opened it
        // and would never finish inside the view, and anything else belongs in the system browser.
        { id: 'open-in-view', label: tr('openInAccountView'), enabled: hostClass(platform, url) === 'service' },
      ],
    },
  ]
}

// What a key or a menu item does in such a window. True when something was done.
export function runInWindow(contents, command) {
  switch (command) {
    case 'back':
    case 'forward':
      return step(contents, command)
    case 'reload':
      contents.reload()
      return true
    case 'hard-reload':
      contents.reloadIgnoringCache()
      return true
    case 'devtools':
      contents.toggleDevTools()
      return true
    default:
      return false
  }
}
