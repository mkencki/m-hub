// The rules around putting accounts to sleep that are not about views: when the operator is
// reminded that accounts are asleep, and what "put all but the current account to sleep" does.
// Pure, with the clock passed in, so they can be examined without Electron and without waiting.

// A sleeping account delivers no notification, and the application lives in the tray: a laptop
// resumes rather than restarts, so the rule that every account wakes at the start would not stop
// one being forgotten for days. So the operator is told – never woken behind their back:
//   'resume'  the computer was away; every sleeping account is mentioned.
//   'show'    the window came back to the front, which happens many times a day. Only once some
//             account has slept for half an hour, and no more than once an hour.
export const REMIND_AFTER_MS = 30 * 60 * 1000
export const REMIND_EVERY_MS = 60 * 60 * 1000

export class SleepReminder {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now
    this.since = new Map()
    this.lastAt = null
  }

  fellAsleep(accountId) {
    this.since.set(accountId, this.now())
  }

  woke(accountId) {
    this.since.delete(accountId)
  }

  // How many sleeping accounts to mention now, or 0 for nothing to say. A reminder given counts
  // against the next one, whichever way it came.
  due(trigger) {
    const count = this.since.size
    if (!count) return 0
    const now = this.now()
    if (trigger === 'show') {
      if (now - Math.min(...this.since.values()) < REMIND_AFTER_MS) return 0
      if (this.lastAt !== null && now - this.lastAt < REMIND_EVERY_MS) return 0
    }
    this.lastAt = now
    return count
  }
}

// Which accounts "put all but the current account to sleep" puts to sleep, given each one's reason
// to refuse (ViewManager.sleepRefusal). The account in front and the ones already asleep are left
// out quietly; the ones that cannot sleep – a call under way, a window open – are named, since the
// operator asked for them too.
const QUIET = new Set(['active', 'asleep', 'missing'])

export function planSleepOthers(accountIds, refusalOf) {
  const toSleep = []
  const kept = []
  for (const id of accountIds) {
    const reason = refusalOf(id)
    if (reason === null) toSleep.push(id)
    else if (!QUIET.has(reason)) kept.push({ id, reason })
  }
  return { toSleep, kept }
}

const KEPT_LABELS = { audible: 'sleepRefusedAudible', 'child-window': 'sleepRefusedChildWindow' }

export function describeSleepOthers({ slept, kept, tr }) {
  const done = tr('sleptOthers', { n: slept })
  if (!kept.length) return done
  const accounts = kept.map(({ name, reason }) => tr(KEPT_LABELS[reason], { account: name })).join(', ')
  return `${done} ${tr('keptAwake', { accounts })}`
}
