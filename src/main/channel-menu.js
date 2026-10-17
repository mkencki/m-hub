// The menu a channel on the rail opens on a right click: what can be done to THAT account,
// whichever account is being looked at. F5 reaches only the account in front of the operator, so
// this is how a white WhatsApp behind the Messenger they are using is brought back without
// switching to it first.
//
// A plain template and nothing else – main.js builds the native menu from it and attaches what
// each item does – so what the menu offers can be examined without Electron.

export function channelMenuTemplate({ account, hasChildWindows, tr }) {
  return [
    // Named at the top. The product exists because two accounts of the same service look alike,
    // and a menu that acts on an account without naming it would be one more place to pick the
    // wrong one.
    { id: 'account', label: account.name, enabled: false },
    { type: 'separator' },
    { id: 'reload', label: tr('channelMenuReload') },
    { id: 'hard-reload', label: tr('channelMenuHardReload') },
    { type: 'separator' },
    // Ending the renderer can take the account's own windows down with it – a sign-in in
    // progress, a comment being typed – when they share its process, which a page of the same
    // site does. Said before the click, not after.
    { id: 'restart', label: tr(hasChildWindows ? 'channelMenuRestartWithWindows' : 'channelMenuRestart') },
  ]
}
