import { describe, test, expect } from 'vitest'
import { channelMenuTemplate } from '../src/main/channel-menu.js'
import { t } from '../src/shared/i18n.js'

const account = { id: 'acc-work', name: 'WhatsApp work' }
const tr = (key, params) => t('en', key, params)

const idsOf = (template) => template.filter((item) => item.id).map((item) => item.id)

describe('the channel menu', () => {
  // F5 reaches only the account being looked at. The menu is how any OTHER account is reloaded
  // without switching to it first – a white WhatsApp behind the Messenger the operator is using.
  test('offers the three ways back for that account', () => {
    expect(idsOf(channelMenuTemplate({ account, hasChildWindows: false, tr }))).toEqual([
      'account',
      'reload',
      'hard-reload',
      'restart',
    ])
  })

  // The product exists because two accounts of the same service look alike. A menu acting on an
  // account it does not name would be one more place to act on the wrong one.
  test('names the account it acts on, as a heading that cannot be clicked', () => {
    const [heading] = channelMenuTemplate({ account, hasChildWindows: false, tr })
    expect(heading.label).toBe('WhatsApp work')
    expect(heading.enabled).toBe(false)
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

  test('separates the heading and the restart from the ordinary reloads', () => {
    const types = channelMenuTemplate({ account, hasChildWindows: false, tr }).map((item) => item.type ?? item.id)
    expect(types).toEqual(['account', 'separator', 'reload', 'hard-reload', 'separator', 'restart'])
  })
})
