// A page with an unsent draft can refuse to be left – its beforeunload handler says so – and
// in a WebContentsView Electron turns that refusal into silence. No dialog appears, no error is
// reported, and the reload, the navigation or the close simply does not happen. Only the
// will-prevent-unload event knows, measured in Electron 43.4.1 while researching this change.
// Without a word from the application, F5 would look dead exactly when there is a draft to lose.
//
// Overriding the page every time would lose the draft without asking, which this application
// refuses everywhere else: a reload is offered, never done behind the operator's back. So a
// refusal is reported, and when it was the answer to something the operator had just asked
// for, the report offers to go ahead with exactly that – once.
//
// The guard keeps three things per account, each short-lived on purpose:
//   armed    what the application is about to do, so a refusal can be traced back to it.
//            Stale after a few seconds: the page's own navigations and the mouse's back button
//            are refused the same way and pass through nothing here, and an old request must
//            not be mistaken for their cause.
//   pending  the refused action, waiting for the operator to choose.
//   allowed  permission for the one repeat of it to leave the draft behind. It runs out, so it
//            can never wave a later, unrelated navigation through.

const ARMED_MS = 5000
const ALLOWED_MS = 15000

export class UnloadGuard {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now
    this.armed = new Map()
    this.pending = new Map()
    this.allowances = new Map()
  }

  arm(accountId, action) {
    this.armed.set(accountId, { action, at: this.now() })
  }

  // Called when the page has refused. Returns the action it refused, or null when the refusal
  // cannot be traced to anything asked for here – then there is nothing to offer.
  blocked(accountId) {
    const entry = this.armed.get(accountId)
    this.armed.delete(accountId)
    if (!entry || this.now() - entry.at > ARMED_MS) return null
    this.pending.set(accountId, entry.action)
    return entry.action
  }

  // The operator chose to go ahead. Returns the action to repeat, and lets that repeat through.
  proceed(accountId) {
    const action = this.pending.get(accountId) ?? null
    this.pending.delete(accountId)
    if (action) this.allowances.set(accountId, this.now() + ALLOWED_MS)
    return action
  }

  // Asked by the refusal itself: may the page be overridden this time? Spent by the asking.
  allowed(accountId) {
    const until = this.allowances.get(accountId)
    this.allowances.delete(accountId)
    return until !== undefined && this.now() <= until
  }
}
