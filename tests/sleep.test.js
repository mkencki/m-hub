import { describe, test, expect } from 'vitest'
import { SleepReminder, REMIND_AFTER_MS, REMIND_EVERY_MS, planSleepOthers, describeSleepOthers } from '../src/main/sleep.js'
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
