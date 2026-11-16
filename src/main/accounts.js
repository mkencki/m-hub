import { readFile, writeFile, rename } from 'node:fs/promises'

export const SCHEMA_VERSION = 2

// `hosts` is what an account is allowed to show in its own view – matched on a dot
// boundary, never as a substring. `authHosts` are foreign hosts a sign-in flow legitimately
// goes through, and they are separate because trusting them is a different decision from
// trusting the service. `external` is consulted BEFORE `hosts` and exists only for entries
// that would otherwise match one: the shims Meta wraps outgoing links in live on the
// service's own domain, so without it every link out would stay inside the account view.
//
// An entry that changes no outcome does not belong here. It would teach the next reader
// that the list was guessed at rather than measured.
// `unreadInTitle` decides whether the channel badge believes what the page calls itself.
// A messenger's "(3)" means three conversations waiting, which is what a badge next to a
// channel is read as. A whole service's number is something else wearing the same clothes,
// and putting the two in one rail makes both of them lie a little. Turning one on is one
// word; the reasons are on each entry.
export const PLATFORMS = {
  whatsapp: {
    url: 'https://web.whatsapp.com/',
    defaultName: 'WhatsApp',
    hosts: ['web.whatsapp.com'],
    authHosts: [],
    external: [],
    unreadInTitle: true,
    notifyByDefault: true,
  },
  messenger: {
    url: 'https://www.messenger.com/',
    defaultName: 'Messenger',
    hosts: ['messenger.com', 'facebook.com', 'meta.com'],
    authHosts: [],
    external: ['l.facebook.com', 'lm.facebook.com', 'www.facebook.com/l.php'],
    unreadInTitle: true,
    notifyByDefault: true,
  },
  // The apex host sits behind an anti-bot gate – measured with curl, twice, and both
  // linkedin.com/ and linkedin.com/feed/ answer "Checking your browser - reCAPTCHA". The www
  // host and the feed path redirect to sign-in and come back to the feed afterwards, and
  // every sub-product (/learning/, /jobs/, /sales/) is on the same origin, so one entry
  // point covers the whole service.
  linkedin: {
    url: 'https://www.linkedin.com/feed/',
    defaultName: 'LinkedIn',
    hosts: ['linkedin.com'],
    // Sign-in genuinely leaves the service. Apple's opens a window and answers back through
    // postMessage to whoever opened it, so it can neither be pushed to the system browser
    // nor silently denied; Microsoft's navigates the main frame instead of opening anything.
    //
    // MEASURED 2026-08-30, after "Sign in with Microsoft" failed: the button goes to
    // login.live.com – the CONSUMER endpoint – and the passkey step that follows goes to
    // login.microsoft.com. Neither was declared here, so both were sent to the system browser
    // and the flow came back with
    //     AADSTS900561: The endpoint only accepts POST requests. Received a GET request.
    // That error is the whole point of declaring them: shell.openExternal can only ever issue
    // a GET, and the authorize call asks for response_mode=form_post. An undeclared sign-in
    // host is not merely opened in the wrong window – it arrives stripped of its method and
    // cannot work anywhere. login.microsoftonline.com is the WORK-account endpoint and stays;
    // which of the two a sign-in uses depends on the account, so both belong here.
    authHosts: [
      'appleid.apple.com',
      'login.live.com',
      'login.microsoft.com',
      'login.microsoftonline.com',
      'edge-auth.microsoft.com',
      'accounts.google.com',
    ],
    external: [],
    // The number in LinkedIn's title is the SUM of eight badge sources – feed, jobs,
    // notifications, messaging and more. In one rail with a WhatsApp "(3)" it would be a
    // different unit in the same clothes, so the badge stays off until the operator says
    // otherwise. The count itself is read correctly now, including "(99+)".
    unreadInTitle: false,
    notifyByDefault: false,
  },
  // Entered at www. The shims below wrap outgoing links so that every one of them LOOKS like
  // a facebook.com address, which is exactly why the external list is consulted before the
  // host list. The enumeration is the confirmed part only: l.facebook.com and lm.facebook.com
  // are attested, and anything further has to be watched happening before it is written here.
  facebook: {
    url: 'https://www.facebook.com/',
    defaultName: 'Facebook',
    hosts: ['facebook.com', 'meta.com'],
    authHosts: [],
    external: ['l.facebook.com', 'lm.facebook.com', 'www.facebook.com/l.php'],
    // The 2026 title format could not be confirmed: the measured baseline is a bare
    // "Facebook", and no prefixed form was reproduced. A badge nobody has seen work would be
    // a promise, so it shows nothing.
    unreadInTitle: false,
  },
}

// Two accounts sharing a colour cancel out the only identity signal the rail gives.
// The form therefore suggests a colour nobody is using yet, rather than always the same one.
export const CHANNEL_PALETTE = [
  '#2f7d5b', // WhatsApp green
  '#6586ec', // Messenger blue
  '#c9a227', // amber
  '#c9722b', // copper
  '#8e6bd1', // violet
  '#3aa6a0', // teal
]

export function unusedColor(accounts = []) {
  const taken = new Set(accounts.map((a) => String(a?.color || '').toLowerCase()))
  return CHANNEL_PALETTE.find((color) => !taken.has(color)) ?? CHANNEL_PALETTE[accounts.length % CHANNEL_PALETTE.length]
}

export function makeAccountId(name, existingIds = []) {
  const stem = String(name)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\u0142/g, 'l')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30)
  const base = `acc-${stem || 'account'}`
  if (!existingIds.includes(base)) return base
  let n = 2
  while (existingIds.includes(`${base}-${n}`)) n += 1
  return `${base}-${n}`
}

// Schema version 1 wrote these keys in Polish, because the app began as a private tool.
// Files written that way are still on disk, so every read accepts both spellings and the
// English one wins. That also covers a half-converted file without sniffing versions.
// Ids are never touched: the session partition is named persist:<id>, so rewriting one
// would sign the account out and demand a fresh QR code.
function normalizeAccount(raw) {
  return {
    id: raw?.id,
    name: raw?.name ?? raw?.nazwa,
    platform: raw?.platform ?? raw?.platforma,
    url: raw?.url,
    color: raw?.color ?? raw?.kolor,
    ...accountSettings(raw),
  }
}

// The devices a page can ask for that an account has a say about, and what it can say. "ask" is
// also what an account with no answer yet gets, so an answer is only ever one somebody gave.
export const MEDIA_DEVICES = ['microphone', 'camera']
export const MEDIA_CHOICES = ['ask', 'allow', 'block']

// The choices an operator makes about an account beyond its name and colour – from the file, from
// the form adding it, from the form editing it. Each is written only when it was said: absent is
// not the same as off, since an accounts.json written before a setting existed has no such field,
// and those accounts keep behaving as they always did. A device choice that is not one of the
// choices is left out rather than turned into one.
export function accountSettings(raw) {
  return {
    ...(raw?.notifications === undefined ? {} : { notifications: Boolean(raw.notifications) }),
    ...(raw?.startAsleep === undefined ? {} : { startAsleep: Boolean(raw.startAsleep) }),
    ...Object.fromEntries(
      MEDIA_DEVICES.filter((device) => MEDIA_CHOICES.includes(raw?.[device])).map((device) => [device, raw[device]]),
    ),
  }
}

// What an account's page gets when it asks for a device: the operator's answer, or the question.
export function mediaChoice(account, device) {
  return MEDIA_DEVICES.includes(device) && MEDIA_CHOICES.includes(account?.[device]) ? account[device] : 'ask'
}

// The answer to a question the application asked about a device, written into the account just as
// the operator would have set it in the account's settings. Nothing else about the account moves.
export function rememberMediaChoice(accounts, id, devices, choice) {
  if (!MEDIA_CHOICES.includes(choice)) return accounts
  const answered = Object.fromEntries(devices.filter((device) => MEDIA_DEVICES.includes(device)).map((device) => [device, choice]))
  return accounts.map((account) => (account.id === id ? { ...account, ...answered } : account))
}

// A messenger notifies when somebody writes to you. A whole service notifies about
// reactions, groups, pages, birthdays and things it would like you to look at, and granting
// both the same permission by default is how an app that was helping becomes an app that is
// shouting. The platform sets the default; the account overrides it in either direction.
//
// Absent is not the same as off: every accounts.json written before this setting existed has
// no such field, and those accounts keep behaving as they always did.
export function notificationsAllowed(account) {
  if (account?.notifications !== undefined) return Boolean(account.notifications)
  return PLATFORMS[account?.platform]?.notifyByDefault === true
}

// An error is returned as a CODE, not as a sentence. Only the renderer knows which
// language is active, so sentences built here would show up in Polish inside an English
// interface. The renderer turns the code into text with t().
export function validateAccount(account) {
  const errors = []
  if (!account || typeof account !== 'object') return [{ code: 'validationName', params: {} }]
  if (!account.id || !/^acc-[a-z0-9-]+$/.test(account.id)) errors.push({ code: 'validationId', params: {} })
  if (!account.name || !String(account.name).trim()) errors.push({ code: 'validationName', params: {} })
  if (!PLATFORMS[account.platform]) errors.push({ code: 'validationPlatform', params: { platform: account.platform } })
  if (!String(account.url || '').startsWith('https://')) errors.push({ code: 'validationUrl', params: {} })
  if (!/^#[0-9a-fA-F]{6}$/.test(account.color || '')) errors.push({ code: 'validationColor', params: {} })
  return errors
}

// Only what the operator sees changes: the name, the channel colour and the choices the form
// holds. The id stays put for the reason above – fixing a typo in a name must not sign the
// account out.
export function updateAccount(accounts, id, changes) {
  const index = accounts.findIndex((a) => a.id === id)
  if (index === -1) return { ok: false, errors: [{ code: 'validationNoSuchAccount', params: {} }] }

  const updated = {
    ...accounts[index],
    name: String(changes?.name ?? '').trim(),
    color: changes?.color ?? accounts[index].color,
    // An update that says nothing about a choice must not reset one already made – the same
    // rule a macro save had to learn about its tags.
    ...accountSettings(changes),
  }
  const errors = validateAccount(updated)
  if (errors.length) return { ok: false, errors }

  const result = [...accounts]
  result[index] = updated
  return { ok: true, accounts: result }
}

// Order in the file is the order of the channels. Moving past either end is not an
// error – the button simply does nothing.
export function moveAccount(accounts, id, offset) {
  const index = accounts.findIndex((a) => a.id === id)
  if (index === -1) return [...accounts]

  const target = index + offset
  if (target < 0 || target >= accounts.length) return [...accounts]

  const result = [...accounts]
  const [account] = result.splice(index, 1)
  result.splice(target, 0, account)
  return result
}

export async function loadAccounts(filePath) {
  let raw
  try {
    raw = await readFile(filePath, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return { version: SCHEMA_VERSION, accounts: [] }
    throw error
  }
  try {
    const data = JSON.parse(raw)
    const list = Array.isArray(data.accounts) ? data.accounts : Array.isArray(data.konta) ? data.konta : []
    const accounts = list.map(normalizeAccount).filter((a) => validateAccount(a).length === 0)
    return { version: SCHEMA_VERSION, accounts }
  } catch {
    await rename(filePath, filePath + '.corrupt')
    return { version: SCHEMA_VERSION, accounts: [] }
  }
}

export async function saveAccounts(filePath, accounts) {
  const seen = new Set()
  for (const account of accounts) {
    const errors = validateAccount(account)
    if (errors.length) throw new Error(`invalid account ${account?.id}: ${errors.map((e) => e.code).join(', ')}`)
    if (seen.has(account.id)) throw new Error(`duplicate id: ${account.id}`)
    seen.add(account.id)
  }
  const content = JSON.stringify({ version: SCHEMA_VERSION, accounts }, null, 2)
  await writeFile(filePath + '.tmp', content, 'utf8')
  await rename(filePath + '.tmp', filePath)
}
