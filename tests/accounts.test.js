import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  loadAccounts,
  saveAccounts,
  validateAccount,
  makeAccountId,
  updateAccount,
  moveAccount,
  unusedColor,
  CHANNEL_PALETTE,
  SCHEMA_VERSION,
  PLATFORMS,
  notificationsAllowed,
  accountSettings,
  mediaChoice,
  rememberMediaChoice,
} from '../src/main/accounts.js'
import { PLATFORM_DEFAULT_NOTIFICATIONS } from '../src/shared/platform-defaults.js'

let dir
let file

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'mhub-'))
  file = path.join(dir, 'accounts.json')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('loadAccounts', () => {
  test('a missing file yields an empty list, not an error', async () => {
    const result = await loadAccounts(file)
    expect(result.accounts).toEqual([])
    expect(result.version).toBe(SCHEMA_VERSION)
  })

  test('reads back saved accounts', async () => {
    const accounts = [
      { id: 'acc-a', name: 'A', platform: 'whatsapp', url: 'https://web.whatsapp.com/', color: '#2f7d5b' },
    ]
    await saveAccounts(file, accounts)
    const result = await loadAccounts(file)
    expect(result.accounts).toHaveLength(1)
    expect(result.accounts[0].id).toBe('acc-a')
  })

  test('a damaged file is set aside as a copy and the app starts empty', async () => {
    await writeFile(file, '{to nie jest json', 'utf8')
    const result = await loadAccounts(file)
    expect(result.accounts).toEqual([])
    const kopia = await readFile(file + '.corrupt', 'utf8')
    expect(kopia).toContain('to nie jest json')
  })
})

describe('validateAccount', () => {
  const valid = {
    id: 'acc-a',
    name: 'A',
    platform: 'whatsapp',
    url: 'https://web.whatsapp.com/',
    color: '#2f7d5b',
  }

  test('a valid account has no errors', () => {
    expect(validateAccount(valid)).toEqual([])
  })

  test('an empty name is an error', () => {
    expect(validateAccount({ ...valid, name: '  ' }).map((error) => error.code)).toContain('validationName')
  })

  test('an unknown platform is an error', () => {
    expect(validateAccount({ ...valid, platform: 'signal' })).toContainEqual({
      code: 'validationPlatform',
      params: { platform: 'signal' },
    })
  })

  test('an address that is not https is an error', () => {
    expect(validateAccount({ ...valid, url: 'http://web.whatsapp.com/' }).map((error) => error.code)).toContain(
      'validationUrl',
    )
  })
})

describe('makeAccountId', () => {
  test('builds an id out of safe characters', () => {
    expect(makeAccountId('WhatsApp work', [])).toMatch(/^acc-[a-z0-9-]+$/)
  })

  test('avoids colliding with an existing id', () => {
    const first = makeAccountId('WhatsApp', [])
    const second = makeAccountId('WhatsApp', [first])
    expect(second).not.toBe(first)
  })

  test('Polish characters are transliterated, not stripped to nothing', () => {
    expect(makeAccountId('Służbowy', [])).toBe('acc-sluzbowy')
  })
})

describe('saveAccounts', () => {
  test('refuses to save on a duplicate id', async () => {
    const accounts = [
      { id: 'acc-a', name: 'A', platform: 'whatsapp', url: 'https://web.whatsapp.com/', color: '#2f7d5b' },
      { id: 'acc-a', name: 'B', platform: 'whatsapp', url: 'https://web.whatsapp.com/', color: '#2f7d5b' },
    ]
    await expect(saveAccounts(file, accounts)).rejects.toThrow(/duplicate id/)
  })
})

const trzyKonta = () => [
  { id: 'acc-messenger', name: 'Messenger', platform: 'messenger', url: 'https://www.messenger.com/', color: '#6586ec' },
  { id: 'acc-whatsapp-priv', name: 'WhatsApp_PRIV', platform: 'whatsapp', url: 'https://web.whatsapp.com/', color: '#2f7d5b' },
  { id: 'acc-whatsapp-work', name: 'WhatsApp_WORK', platform: 'whatsapp', url: 'https://web.whatsapp.com/', color: '#2f7d5b' },
]

describe('updateAccount', () => {
  test('a rename does NOT touch the id, because the session partition rests on it', () => {
    const result = updateAccount(trzyKonta(), 'acc-whatsapp-priv', { name: 'WhatsApp Dom', color: '#2f7d5b' })

    expect(result.ok).toBe(true)
    expect(result.accounts[1].id).toBe('acc-whatsapp-priv')
    expect(result.accounts[1].name).toBe('WhatsApp Dom')
  })

  test('an update leaves the account in the same position', () => {
    const result = updateAccount(trzyKonta(), 'acc-messenger', { name: 'Messenger firmowy', color: '#6586ec' })

    expect(result.accounts.map((k) => k.id)).toEqual(['acc-messenger', 'acc-whatsapp-priv', 'acc-whatsapp-work'])
  })

  test('platform and address survive a rename', () => {
    const result = updateAccount(trzyKonta(), 'acc-whatsapp-work', { name: 'Praca', color: '#123456' })

    expect(result.accounts[2].platform).toBe('whatsapp')
    expect(result.accounts[2].url).toBe('https://web.whatsapp.com/')
    expect(result.accounts[2].color).toBe('#123456')
  })

  test('an empty name is refused and the list stays untouched', () => {
    const accounts = trzyKonta()
    const result = updateAccount(accounts, 'acc-messenger', { name: '   ', color: '#6586ec' })

    expect(result.ok).toBe(false)
    expect(result.errors.map((error) => error.code)).toContain('validationName')
    expect(accounts[0].name).toBe('Messenger')
  })

  // The renderer picks the interface language, so the main process must not return
  // finished sentences: Polish ones would leak into an English interface. It hands back
  // a code and parameters, and t() assembles the text.
  test('validation errors come back as codes with parameters, not finished sentences', () => {
    const errors = validateAccount({ id: 'acc-x', name: '', platform: 'unknown', url: 'http://x', color: 'green' })

    expect(errors.map((error) => error.code)).toEqual([
      'validationName',
      'validationPlatform',
      'validationUrl',
      'validationColor',
    ])
    expect(errors.find((error) => error.code === 'validationPlatform').params).toEqual({ platform: 'unknown' })
  })

  test('an unknown id yields an error, not an exception', () => {
    expect(updateAccount(trzyKonta(), 'acc-nie-ma', { name: 'X', color: '#000000' }).ok).toBe(false)
  })
})

describe('moveAccount', () => {
  test('moving up swaps the account with the previous one', () => {
    const result = moveAccount(trzyKonta(), 'acc-whatsapp-priv', -1)

    expect(result.map((k) => k.id)).toEqual(['acc-whatsapp-priv', 'acc-messenger', 'acc-whatsapp-work'])
  })

  test('moving down swaps the account with the next one', () => {
    const result = moveAccount(trzyKonta(), 'acc-messenger', 1)

    expect(result.map((k) => k.id)).toEqual(['acc-whatsapp-priv', 'acc-messenger', 'acc-whatsapp-work'])
  })

  test('the first account cannot be moved further up', () => {
    const result = moveAccount(trzyKonta(), 'acc-messenger', -1)

    expect(result.map((k) => k.id)).toEqual(['acc-messenger', 'acc-whatsapp-priv', 'acc-whatsapp-work'])
  })

  test('the last account cannot be moved further down', () => {
    const result = moveAccount(trzyKonta(), 'acc-whatsapp-work', 1)

    expect(result.map((k) => k.id)).toEqual(['acc-messenger', 'acc-whatsapp-priv', 'acc-whatsapp-work'])
  })

  test('the source list stays untouched', () => {
    const accounts = trzyKonta()
    moveAccount(accounts, 'acc-messenger', 1)

    expect(accounts.map((k) => k.id)).toEqual(['acc-messenger', 'acc-whatsapp-priv', 'acc-whatsapp-work'])
  })
})

describe('unusedColor', () => {
  test('the first account gets the first colour of the palette', () => {
    expect(unusedColor([])).toBe(CHANNEL_PALETTE[0])
  })

  test('a second account does NOT get the colour of the first, which is what channel identity rests on', () => {
    const zajety = [{ color: CHANNEL_PALETTE[0] }]

    expect(unusedColor(zajety)).not.toBe(CHANNEL_PALETTE[0])
    expect(CHANNEL_PALETTE).toContain(unusedColor(zajety))
  })

  test('the comparison ignores the case of the colour', () => {
    expect(unusedColor([{ color: CHANNEL_PALETTE[0].toUpperCase() }])).not.toBe(CHANNEL_PALETTE[0])
  })

  test('with the whole palette taken it wraps to the first rather than returning nothing', () => {
    const all = CHANNEL_PALETTE.map((color) => ({ color }))

    expect(CHANNEL_PALETTE).toContain(unusedColor(all))
  })
})

describe('what a platform declares', () => {
  test('every platform says whether its title carries a count', () => {
    for (const [name, platform] of Object.entries(PLATFORMS)) {
      expect(typeof platform.unreadInTitle, name).toBe('boolean')
    }
  })

  // A messenger's "(3)" means three conversations waiting. LinkedIn's number is the SUM of
  // eight badge sources – feed, jobs, notifications, messaging and more – so next to a
  // WhatsApp count in the same rail it is a different unit wearing the same clothes.
  // Facebook's format could not be confirmed for 2026 at all. Both therefore show nothing
  // rather than something misleading; turning either on is one word.
  test('the two whole services do not pretend to count messages', () => {
    expect(PLATFORMS.linkedin.unreadInTitle).toBe(false)
    expect(PLATFORMS.facebook.unreadInTitle).toBe(false)
  })

  test('the messengers still count, because their number means what it looks like', () => {
    expect(PLATFORMS.whatsapp.unreadInTitle).toBe(true)
    expect(PLATFORMS.messenger.unreadInTitle).toBe(true)
  })

  // Measured with curl, twice: the apex host answers "Checking your browser - reCAPTCHA".
  // The entry point has to be the www host and the feed path.
  test('LinkedIn is entered at www and at the feed, never at the apex', () => {
    expect(PLATFORMS.linkedin.url).toBe('https://www.linkedin.com/feed/')
  })

  // Apple's sign-in opens a window and answers back through postMessage to whoever opened
  // it, so it can neither go to the system browser nor be silently denied. Captured:
  // appleid.apple.com/auth/authorize?…response_mode=web_message, frameName
  // AppleAuthentication, disposition new-window.
  test('LinkedIn declares the sign-in hosts its own flows go through', () => {
    expect(PLATFORMS.linkedin.authHosts).toContain('appleid.apple.com')
    expect(PLATFORMS.linkedin.authHosts).toContain('login.microsoftonline.com')
  })

  // These wrap outgoing links so that every one of them looks like a facebook.com address.
  test('Facebook declares the shims that make a link out look like a link in', () => {
    expect(PLATFORMS.facebook.external).toContain('l.facebook.com')
    expect(PLATFORMS.facebook.external).toContain('www.facebook.com/l.php')
  })

  test('a new platform is a valid one to build an account on', () => {
    for (const name of ['linkedin', 'facebook']) {
      const account = { id: 'acc-x', name: 'X', platform: name, url: PLATFORMS[name].url, color: '#2f7d5b' }
      expect(validateAccount(account), name).toEqual([])
    }
  })
})

describe('who is allowed to interrupt', () => {
  // A messenger notifies when somebody writes to you. A whole service notifies about
  // reactions, groups, pages, birthdays and things it would like you to look at. Granting
  // both the same permission by default is how an app that was helping becomes an app that
  // is shouting.
  test('messengers may interrupt out of the box', () => {
    expect(notificationsAllowed({ platform: 'whatsapp' })).toBe(true)
    expect(notificationsAllowed({ platform: 'messenger' })).toBe(true)
  })

  test('whole services stay quiet until asked', () => {
    expect(notificationsAllowed({ platform: 'linkedin' })).toBe(false)
    expect(notificationsAllowed({ platform: 'facebook' })).toBe(false)
  })

  test('the account has the last word, in both directions', () => {
    expect(notificationsAllowed({ platform: 'facebook', notifications: true })).toBe(true)
    expect(notificationsAllowed({ platform: 'whatsapp', notifications: false })).toBe(false)
  })

  // Every accounts.json written before this setting existed has no such field, and absent
  // must mean "whatever this platform does by default" rather than "no".
  test('an account written before the setting existed keeps its platform default', () => {
    expect(notificationsAllowed({ platform: 'whatsapp', notifications: undefined })).toBe(true)
    expect(notificationsAllowed({ platform: 'facebook', notifications: undefined })).toBe(false)
  })

  test('a platform nobody knows does not get to interrupt', () => {
    expect(notificationsAllowed({ platform: 'unknown' })).toBe(false)
    expect(notificationsAllowed(undefined)).toBe(false)
  })
})

// Mirrored for the renderer, which cannot import this module. A copy is a liability unless
// something notices when the two disagree.
test('the copy of the notification defaults in the renderer matches the real ones', () => {
  for (const [name, platform] of Object.entries(PLATFORMS)) {
    expect(PLATFORM_DEFAULT_NOTIFICATIONS[name], name).toBe(platform.notifyByDefault === true)
  }
  expect(Object.keys(PLATFORM_DEFAULT_NOTIFICATIONS).sort()).toEqual(Object.keys(PLATFORMS).sort())
})

describe('updating the notification choice', () => {
  const account = { id: 'acc-fb', name: 'Facebook', platform: 'facebook', url: 'https://www.facebook.com/', color: '#6586ec' }

  test('the choice is stored, not quietly dropped', () => {
    const result = updateAccount([account], 'acc-fb', { name: 'Facebook', color: '#6586ec', notifications: true })

    expect(result.ok).toBe(true)
    expect(result.accounts[0].notifications).toBe(true)
    expect(notificationsAllowed(result.accounts[0])).toBe(true)
  })

  test('turning it off is stored as off, not as never chosen', () => {
    const withIt = { ...account, notifications: true }

    const result = updateAccount([withIt], 'acc-fb', { name: 'Facebook', color: '#6586ec', notifications: false })

    expect(result.accounts[0].notifications).toBe(false)
  })

  // An update that says nothing about it must not silently reset a choice already made,
  // for the same reason a macro save stopped erasing tags.
  test('an update that does not mention it leaves it alone', () => {
    const withIt = { ...account, notifications: true }

    const result = updateAccount([withIt], 'acc-fb', { name: 'Facebook', color: '#6586ec' })

    expect(result.accounts[0].notifications).toBe(true)
  })
})

// Three choices an account carries since 0.8.0: whether it starts asleep, and what its page gets
// when it asks for the microphone or the camera.
describe('what an account keeps besides its name', () => {
  const base = { id: 'acc-wa', name: 'WhatsApp', platform: 'whatsapp', url: 'https://web.whatsapp.com/', color: '#2f7d5b' }

  test('the choices survive a read of the file', async () => {
    await writeFile(file, JSON.stringify({ version: 2, accounts: [{ ...base, startAsleep: true, microphone: 'allow', camera: 'block' }] }))
    const { accounts } = await loadAccounts(file)
    expect(accounts[0]).toMatchObject({ startAsleep: true, microphone: 'allow', camera: 'block' })
  })

  // A value no version of the application ever wrote is nobody's answer, so it reads as the question
  // it would otherwise be – never as a yes.
  test('a device choice the application does not know reads as never made', async () => {
    await writeFile(file, JSON.stringify({ version: 2, accounts: [{ ...base, microphone: 'always', camera: true }] }))
    const { accounts } = await loadAccounts(file)
    expect(accounts[0]).not.toHaveProperty('microphone')
    expect(accounts[0]).not.toHaveProperty('camera')
    expect(mediaChoice(accounts[0], 'microphone')).toBe('ask')
    expect(mediaChoice(accounts[0], 'camera')).toBe('ask')
  })

  test('an account written before these choices existed starts awake and asks', async () => {
    await writeFile(file, JSON.stringify({ version: 2, accounts: [base] }))
    const { accounts } = await loadAccounts(file)
    expect(accounts[0].startAsleep).toBeUndefined()
    expect(mediaChoice(accounts[0], 'microphone')).toBe('ask')
    expect(mediaChoice(accounts[0], 'camera')).toBe('ask')
  })

  test('a device the application has no setting for is never allowed', () => {
    expect(mediaChoice({ ...base, microphone: 'allow' }, 'screen')).toBe('ask')
    expect(mediaChoice(undefined, 'microphone')).toBe('ask')
  })
})

describe('updating the start and the devices', () => {
  const account = { id: 'acc-wa', name: 'WhatsApp', platform: 'whatsapp', url: 'https://web.whatsapp.com/', color: '#2f7d5b' }
  const named = { name: 'WhatsApp', color: '#2f7d5b' }

  test('starting asleep is stored either way', () => {
    const on = updateAccount([account], 'acc-wa', { ...named, startAsleep: true })
    expect(on.accounts[0].startAsleep).toBe(true)
    const off = updateAccount(on.accounts, 'acc-wa', { ...named, startAsleep: false })
    expect(off.accounts[0].startAsleep).toBe(false)
  })

  test('a device choice is stored, and one that is not a choice leaves the old one in place', () => {
    const chosen = updateAccount([account], 'acc-wa', { ...named, microphone: 'allow', camera: 'block' })
    expect(chosen.accounts[0]).toMatchObject({ microphone: 'allow', camera: 'block' })
    const garbled = updateAccount(chosen.accounts, 'acc-wa', { ...named, microphone: 'yes please' })
    expect(garbled.accounts[0].microphone).toBe('allow')
  })

  // The same rule as for notifications: an update that says nothing about a choice keeps it.
  test('an update that does not mention them leaves them alone', () => {
    const withThem = { ...account, startAsleep: true, microphone: 'block', camera: 'allow' }
    const result = updateAccount([withThem], 'acc-wa', named)
    expect(result.accounts[0]).toMatchObject({ startAsleep: true, microphone: 'block', camera: 'allow' })
  })
})

describe('what the form may set on an account', () => {
  test('only the settings it said something about, and only valid ones', () => {
    expect(
      accountSettings({ name: 'x', color: '#000000', notifications: false, startAsleep: true, microphone: 'allow', camera: 'sometimes' }),
    ).toEqual({ notifications: false, startAsleep: true, microphone: 'allow' })
    expect(accountSettings({})).toEqual({})
    expect(accountSettings(undefined)).toEqual({})
  })
})

// The question about a device is asked once; the answer is written into the account as the operator
// would have set it in its settings, and nothing else about the account moves.
describe('remembering an answer about a device', () => {
  const base = { id: 'acc-wa', name: 'WhatsApp', platform: 'whatsapp', url: 'https://web.whatsapp.com/', color: '#2f7d5b' }

  test('the answer is written for the devices asked about, and for that account only', () => {
    const accounts = [{ ...base, camera: 'block' }, { ...base, id: 'acc-other' }]
    const result = rememberMediaChoice(accounts, 'acc-wa', ['microphone'], 'allow')
    expect(result[0]).toMatchObject({ microphone: 'allow', camera: 'block', name: 'WhatsApp' })
    expect(result[1]).not.toHaveProperty('microphone')
    expect(accounts[0]).not.toHaveProperty('microphone')
  })

  test('both devices at once, when the page asked for both', () => {
    const [account] = rememberMediaChoice([base], 'acc-wa', ['microphone', 'camera'], 'block')
    expect(account).toMatchObject({ microphone: 'block', camera: 'block' })
  })

  test('an answer that is not a choice, or an account that is gone, changes nothing', () => {
    expect(rememberMediaChoice([base], 'acc-wa', ['microphone'], 'maybe')).toEqual([base])
    expect(rememberMediaChoice([base], 'acc-gone', ['microphone'], 'allow')).toEqual([base])
  })
})
