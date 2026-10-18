// The menu a channel on the rail opens on a right click: what can be done to THAT account,
// whichever account is being looked at. F5 reaches only the account in front of the operator, so
// this is how a white WhatsApp behind the Messenger they are using is brought back without
// switching to it first – and how an account is put to sleep, or woken, by hand.
//
// A plain template and nothing else – main.js builds the native menu from it and attaches what
// each item does – so what the menu offers can be examined without Electron.

// Why an account cannot sleep, as the label of the greyed item. A greyed item that does not say why
// reads as broken. The account in front needs no reason: it is the one being looked at.
const SLEEP_LABELS = {
  audible: 'channelMenuSleepAudible',
  'child-window': 'channelMenuSleepWindows',
}

export function channelMenuTemplate({ account, hasChildWindows, asleep = false, sleepRefusal = null, canSleepOthers = true, tr }) {
  // Named at the top. The product exists because two accounts of the same service look alike,
  // and a menu that acts on an account without naming it would be one more place to pick the
  // wrong one.
  const heading = { id: 'account', label: account.name, enabled: false }
  // Every account but the one in front, from any channel: the operator's scenario is one account
  // to work in and memory for it, in one click.
  const sleepOthers = { id: 'sleep-others', label: tr('channelMenuSleepOthers'), enabled: canSleepOthers }

  // A sleeping account has no page, so there is nothing to reload, restart or put to sleep. Woken
  // from here it wakes in the background; a click on the channel wakes it and shows it.
  if (asleep) {
    return [heading, { type: 'separator' }, { id: 'wake', label: tr('channelMenuWake') }, { type: 'separator' }, sleepOthers]
  }

  return [
    heading,
    { type: 'separator' },
    { id: 'reload', label: tr('channelMenuReload') },
    { id: 'hard-reload', label: tr('channelMenuHardReload') },
    { type: 'separator' },
    // Ending the renderer can take the account's own windows down with it – a sign-in in
    // progress, a comment being typed – when they share its process, which a page of the same
    // site does. Said before the click, not after.
    { id: 'restart', label: tr(hasChildWindows ? 'channelMenuRestartWithWindows' : 'channelMenuRestart') },
    { type: 'separator' },
    {
      id: 'sleep',
      label: tr(SLEEP_LABELS[sleepRefusal] ?? 'channelMenuSleep'),
      enabled: sleepRefusal === null,
    },
    sleepOthers,
  ]
}
