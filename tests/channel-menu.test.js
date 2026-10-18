import { describe, test, expect } from 'vitest'
import { channelMenuTemplate } from '../src/main/channel-menu.js'
import { t } from '../src/shared/i18n.js'

const account = { id: 'acc-work', name: 'WhatsApp work' }
const tr = (key, params) => t('en', key, params)

const idsOf = (template) => template.filter((item) => item.id).map((item) => item.id)

const itemOf = (template, id) => template.find((item) => item.id === id)

describe('the channel menu', () => {
  // F5 reaches only the account being looked at. The menu is how any OTHER account is reloaded
  // without switching to it first – a white WhatsApp behind the Messenger the operator is using.
  // And how an account is put to sleep, or all of them but the one in front.
  test('offers the three ways back for that account, then sleep', () => {
    expect(idsOf(channelMenuTemplate({ account, hasChildWindows: false, tr }))).toEqual([
      'account',
      'reload',
      'hard-reload',
      'restart',
      'sleep',
      'sleep-others',
    ])
  })

  // The product exists because two accounts of the same service look alike. A menu acting on an
  // account it does not name would be one more place to act on the wrong one.
  test('names the account it acts on, as a heading that cannot be clicked', () => {
    const [heading] = channelMenuTemplate({ account, hasChildWindows: false, tr })
    expect(heading.label).toBe('WhatsApp work')
    expect(heading.enabled).toBe(false)
  })

  // The status bar offers the same act when an account crashes or the computer wakes up. Two
  // words for one act read as two different acts.
  test('calls a reload by the name the status bar uses', () => {
    for (const language of ['en', 'pl']) {
      const template = channelMenuTemplate({ account, hasChildWindows: false, tr: (key) => t(language, key) })
      expect(template.find((item) => item.id === 'reload').label).toBe(t(language, 'reloadAccount'))
    }
  })

  test('labels its items in the interface language', () => {
    const template = channelMenuTemplate({ account, hasChildWindows: false, tr: (key) => t('pl', key) })
    expect(template.find((item) => item.id === 'reload').label).toBe('Odśwież')
  })

  // Ending the renderer can take the account's own popups with it – a sign-in in progress, a
  // comment being typed – so when there are any, the item says so before it is clicked.
  test('a restart warns when the account has windows of its own open', () => {
    const quiet = channelMenuTemplate({ account, hasChildWindows: false, tr })
    const warned = channelMenuTemplate({ account, hasChildWindows: true, tr })
    const restart = (template) => template.find((item) => item.id === 'restart').label

    expect(restart(warned)).not.toBe(restart(quiet))
    expect(restart(warned)).toMatch(/window/i)
  })

  test('separates the heading, the restart and sleep from the ordinary reloads', () => {
    const types = channelMenuTemplate({ account, hasChildWindows: false, tr }).map((item) => item.type ?? item.id)
    expect(types).toEqual([
      'account',
      'separator',
      'reload',
      'hard-reload',
      'separator',
      'restart',
      'separator',
      'sleep',
      'sleep-others',
    ])
  })
})

describe('sleep in the channel menu', () => {
  test('an account that can sleep is offered sleep', () => {
    const sleep = itemOf(channelMenuTemplate({ account, sleepRefusal: null, tr }), 'sleep')
    expect(sleep.label).toBe(tr('channelMenuSleep'))
    expect(sleep.enabled ?? true).toBe(true)
  })

  // The operator is using the account in front; putting it to sleep would put out the page they are
  // looking at.
  test('the account in front cannot be put to sleep', () => {
    expect(itemOf(channelMenuTemplate({ account, sleepRefusal: 'active', tr }), 'sleep').enabled).toBe(false)
  })

  // Greyed with the reason in the label: a greyed item that does not say why reads as broken.
  test('an account playing sound, or with a window open, says why it cannot sleep', () => {
    const audible = itemOf(channelMenuTemplate({ account, sleepRefusal: 'audible', tr }), 'sleep')
    const windows = itemOf(channelMenuTemplate({ account, sleepRefusal: 'child-window', tr }), 'sleep')
    expect(audible.enabled).toBe(false)
    expect(audible.label).toMatch(/sound/)
    expect(windows.enabled).toBe(false)
    expect(windows.label).toMatch(/window/)
  })

  test('putting the others to sleep needs someone else awake', () => {
    expect(itemOf(channelMenuTemplate({ account, canSleepOthers: true, tr }), 'sleep-others').enabled ?? true).toBe(true)
    expect(itemOf(channelMenuTemplate({ account, canSleepOthers: false, tr }), 'sleep-others').enabled).toBe(false)
  })

  // A sleeping account has no page: nothing to reload or restart, and nothing to put to sleep. Waking
  // it from here leaves the operator on the account they are using.
  test('a sleeping account offers to wake, and nothing that needs a page', () => {
    const template = channelMenuTemplate({ account, asleep: true, canSleepOthers: true, tr })
    expect(idsOf(template)).toEqual(['account', 'wake', 'sleep-others'])
    expect(itemOf(template, 'wake').label).toBe(tr('channelMenuWake'))
    expect(itemOf(template, 'account').label).toBe('WhatsApp work')
  })

  test('labels sleep in the interface language', () => {
    const pl = (key) => t('pl', key)
    expect(itemOf(channelMenuTemplate({ account, tr: pl }), 'sleep').label).toBe('Uśpij')
    expect(itemOf(channelMenuTemplate({ account, asleep: true, tr: pl }), 'wake').label).toBe('Obudź')
  })
})
