import { describe, test, expect } from 'vitest'
import {
  SleepReminder,
  REMIND_AFTER_MS,
  REMIND_EVERY_MS,
  planSleepOthers,
  describeSleepOthers,
  planStart,
} from '../src/main/sleep.js'
import { t } from '../src/shared/i18n.js'

const MINUTE = 60 * 1000

describe('the reminder that accounts are asleep', () => {
  const clocked = () => {
    const clock = { at: 1_000_000 }
    return { clock, reminder: new SleepReminder({ now: () => clock.at }) }
  }

  test('nothing asleep, nothing to say', () => {
    const { reminder } = clocked()
    expect(reminder.due('resume')).toBe(0)
    expect(reminder.due('show')).toBe(0)
  })

  // A laptop that resumes has been away for a while, and the application did not restart: the rule
  // that every account wakes at the start does not reach it.
  test('after the computer resumes, every sleeping account is mentioned', () => {
    const { reminder } = clocked()
    reminder.fellAsleep('acc-a')
    reminder.fellAsleep('acc-b')
    expect(reminder.due('resume')).toBe(2)
  })

  // The window comes back from the tray many times a day. Right after putting accounts to sleep the
  // operator knows; half an hour on they may not, and once an hour is enough to be told.
  test('when the window comes back, only for a sleep that has lasted, and not too often', () => {
    const { clock, reminder } = clocked()
    reminder.fellAsleep('acc-a')

    clock.at += 10 * MINUTE
    expect(reminder.due('show')).toBe(0)

    clock.at += REMIND_AFTER_MS
    expect(reminder.due('show')).toBe(1)

    clock.at += 10 * MINUTE
    expect(reminder.due('show')).toBe(0)

    clock.at += REMIND_EVERY_MS
    expect(reminder.due('show')).toBe(1)
  })

  test('a reminder after the resume is not repeated when the window then comes back', () => {
    const { clock, reminder } = clocked()
    reminder.fellAsleep('acc-a')
    clock.at += REMIND_AFTER_MS + MINUTE
    expect(reminder.due('resume')).toBe(1)
    clock.at += MINUTE
    expect(reminder.due('show')).toBe(0)
  })

  test('an account woken, or removed, is no longer counted', () => {
    const { reminder } = clocked()
    reminder.fellAsleep('acc-a')
    reminder.fellAsleep('acc-b')
    reminder.woke('acc-a')
    expect(reminder.due('resume')).toBe(1)
    reminder.woke('acc-b')
    expect(reminder.due('resume')).toBe(0)
  })
})

// An account set to start asleep is asleep by the operator's standing choice, not forgotten: the
// reminder exists for the second case and would only nag about the first.
describe('the reminder and accounts asleep by choice', () => {
  const clocked = (chosen) => {
    const clock = { at: 1_000_000 }
    const reminder = new SleepReminder({ now: () => clock.at, exempt: (id) => chosen.has(id) })
    return { clock, reminder }
  }

  test('an account set to start asleep is never mentioned', () => {
    const { clock, reminder } = clocked(new Set(['acc-a']))
    reminder.fellAsleep('acc-a')
    expect(reminder.due('resume')).toBe(0)
    clock.at += REMIND_AFTER_MS + REMIND_EVERY_MS
    expect(reminder.due('show')).toBe(0)
  })

  test('only the accounts put to sleep by hand are counted', () => {
    const { reminder } = clocked(new Set(['acc-a']))
    reminder.fellAsleep('acc-a')
    reminder.fellAsleep('acc-b')
    expect(reminder.due('resume')).toBe(1)
  })

  // The half hour belongs to a sleep the operator might have forgotten, not to one they chose.
  test('the half hour runs from the oldest sleep that counts', () => {
    const { clock, reminder } = clocked(new Set(['acc-a']))
    reminder.fellAsleep('acc-a')
    clock.at += REMIND_AFTER_MS + MINUTE
    reminder.fellAsleep('acc-b')
    clock.at += 10 * MINUTE
    expect(reminder.due('show')).toBe(0)
  })

  test('an account no longer set to start asleep is counted again, from when it fell asleep', () => {
    const chosen = new Set(['acc-a'])
    const { clock, reminder } = clocked(chosen)
    reminder.fellAsleep('acc-a')
    clock.at += REMIND_AFTER_MS + MINUTE
    chosen.delete('acc-a')
    expect(reminder.due('show')).toBe(1)
  })
})

// Which accounts get no view when the application starts, and which one is in front.
describe('the start', () => {
  const account = (key, startAsleep) => ({ id: `acc-${key}`, ...(startAsleep === undefined ? {} : { startAsleep }) })

  test('an account set to start asleep gets no view, and the first awake one is in front', () => {
    expect(planStart([account('a', true), account('b'), account('c', true)])).toEqual({
      front: 'acc-b',
      asleep: ['acc-a', 'acc-c'],
    })
  })

  // The rule the rail already keeps when the account in front goes: something has to be in front.
  test('with every account set to start asleep, the first one wakes', () => {
    expect(planStart([account('a', true), account('b', true)])).toEqual({ front: 'acc-a', asleep: ['acc-b'] })
  })

  test('accounts with no such setting, or with it off, all start awake', () => {
    expect(planStart([account('a'), account('b', false)])).toEqual({ front: 'acc-a', asleep: [] })
  })

  test('no accounts, nothing in front', () => {
    expect(planStart([])).toEqual({ front: null, asleep: [] })
  })
})

describe('putting all but the current account to sleep', () => {
  const refusals = {
    'acc-a': 'active',
    'acc-b': null,
    'acc-c': 'child-window',
    'acc-d': 'asleep',
    'acc-e': 'audible',
    'acc-f': null,
  }

  // The account in front and the ones already asleep are not the operator's business here; the ones
  // that cannot sleep are, and are named rather than skipped in silence.
  test('sleeps whoever can sleep, and lists who stayed awake and why', () => {
    expect(planSleepOthers(Object.keys(refusals), (id) => refusals[id])).toEqual({
      toSleep: ['acc-b', 'acc-f'],
      kept: [
        { id: 'acc-c', reason: 'child-window' },
        { id: 'acc-e', reason: 'audible' },
      ],
    })
  })

  test('says how many fell asleep and names the ones kept awake', () => {
    const tr = (key, params) => t('en', key, params)
    expect(describeSleepOthers({ slept: 2, kept: [], tr })).toBe('2 accounts put to sleep.')
    expect(
      describeSleepOthers({
        slept: 1,
        kept: [
          { name: 'Account two', reason: 'child-window' },
          { name: 'Account four', reason: 'audible' },
        ],
        tr,
      }),
    ).toBe('1 account put to sleep. Kept awake: Account two (a window is open), Account four (playing sound).')
  })

  test('says it in Polish too', () => {
    const tr = (key, params) => t('pl', key, params)
    expect(describeSleepOthers({ slept: 3, kept: [{ name: 'Praca', reason: 'audible' }], tr })).toBe(
      'Uśpiono 3 konta. Nie uśpiono: Praca (odtwarza dźwięk).',
    )
  })
})
