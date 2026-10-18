import { describe, test, expect } from 'vitest'
import { switchAccountHandler } from '../src/main/bridge.js'

// Choosing an account on the rail or with Ctrl+1..9 used to be immediate. Now choosing a sleeping
// one wakes it first, and waking takes a moment – long enough for the operator to choose again.

const managerWith = ({ asleep = [] } = {}) => {
  const shown = []
  return {
    shown,
    isAsleep: (id) => asleep.includes(id),
    isFallingAsleep: () => false,
    show: (id) => shown.push(id),
  }
}

describe('switching accounts', () => {
  test('a sleeping account is woken, then shown', async () => {
    const manager = managerWith({ asleep: ['acc-x'] })
    const woken = []
    const announced = []
    const switchTo = switchAccountHandler({
      manager,
      wakeAccount: async (id) => woken.push(id),
      onAccountShown: (id) => announced.push(id),
    })

    await switchTo('acc-x')

    expect(woken).toEqual(['acc-x'])
    expect(manager.shown).toEqual(['acc-x'])
    expect(announced).toEqual(['acc-x'])
  })

  // The later choice is the operator's last word. Shown after it, the account still waking would
  // take the screen while the rail and the status bar speak for the one chosen last.
  test('a switch overtaken while its account wakes shows nothing', async () => {
    const manager = managerWith({ asleep: ['acc-x'] })
    let finishWaking
    const switchTo = switchAccountHandler({
      manager,
      wakeAccount: () => new Promise((done) => (finishWaking = done)),
      onAccountShown: () => {},
    })

    const first = switchTo('acc-x')
    await switchTo('acc-y')
    finishWaking(true)
    await first

    expect(manager.shown).toEqual(['acc-y'])
  })
})
