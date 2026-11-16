// The tray's menu: what it offers, in which order, and when an item is greyed. Pure, like the
// channel menu, so it can be examined without a tray; main wires each id to what it does.
export function trayMenuTemplate({ autoStart, canSleepOthers, anyAsleep, tr }) {
  return [
    { id: 'show', label: tr('trayShow') },
    { type: 'separator' },
    // The operator's scenario from the channel menu, without opening the window first – greyed, as
    // there, with nobody to put to sleep.
    { id: 'sleep-others', label: tr('channelMenuSleepOthers'), enabled: canSleepOthers },
    // Every sleeping account, those set to start asleep included: here the operator asks for all.
    { id: 'wake-all', label: tr('trayWakeAll'), enabled: anyAsleep },
    { type: 'separator' },
    { id: 'auto-start', label: tr('trayAutoStart'), type: 'checkbox', checked: autoStart },
    // The log only earns its keep if the person it is for can find it. Everything in it is written
    // by this app and is safe to send on – see log.js.
    { id: 'open-logs', label: tr('trayOpenLogs') },
    { type: 'separator' },
    { id: 'quit', label: tr('trayQuit') },
  ]
}
