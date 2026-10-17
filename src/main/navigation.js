// Where an address is allowed to open.
//
// Until this existed, a link in a conversation opened a BARE Electron window: no address
// bar, no back, no reload – and inside the account's signed-in session. That is a defect on
// its own, and it becomes a blocker the moment an account hosts a whole service rather than
// a messenger, because then a single view is a few hundred outgoing links.
//
// The decision cannot rest on how the window was asked for. A sign-in popup and a link to a
// news article are indistinguishable by disposition or by the features string – measured
// while surveying LinkedIn's sign-in flows. So it rests on a declared list of hosts per
// platform: an allowlist, not a guess.

const WEB_SCHEMES = new Set(['http:', 'https:'])

// A dot boundary, never a substring. `facebook.com.example.invalid` ends with the service
// name and belongs to whoever registered example.invalid; substring matching would hand
// them the account's session.
function hostMatches(hostname, entry) {
  return hostname === entry || hostname.endsWith('.' + entry)
}

// An external entry is either a host or a host with a path prefix, because the shims Meta
// wraps outgoing links in live at a PATH on the service's own host: www.facebook.com/l.php.
function shimMatches(url, entry) {
  const slash = entry.indexOf('/')
  if (slash === -1) return hostMatches(url.hostname, entry)
  return url.hostname === entry.slice(0, slash) && url.pathname.startsWith(entry.slice(slash))
}

// What kind of place an address is, by the platform's declared lists: 'service', 'auth',
// 'shim', 'external' or 'block'. classify decides from this, and the log records it in place
// of the address – a sign-in popup and an article look the same by disposition, and only the
// class tells them apart without saying which person or page it was.
export function hostClass(platform, address) {
  let url
  try {
    url = new URL(String(address))
  } catch {
    return 'block'
  }

  // shell.openExternal launches whatever the operating system has associated with a scheme,
  // so anything that is not a web page is refused rather than passed on.
  if (!WEB_SCHEMES.has(url.protocol)) return 'block'

  const hosts = platform?.hosts ?? []
  const authHosts = platform?.authHosts ?? []
  const external = platform?.external ?? []

  // BEFORE the host list, not after. A link shim makes every outgoing link look like a URL
  // on the service's own domain, so checking hosts first would keep the entire web inside
  // the account view.
  if (external.some((entry) => shimMatches(url, entry))) return 'shim'
  if (hosts.some((entry) => hostMatches(url.hostname, entry))) return 'service'
  if (authHosts.some((entry) => hostMatches(url.hostname, entry))) return 'auth'
  return 'external'
}

export function classify(platform, address, { viaWindowOpen = false } = {}) {
  const kind = hostClass(platform, address)
  if (kind === 'block') return 'block'
  if (kind === 'shim' || kind === 'external') return 'external'

  // The same address means different things depending on how it was reached. Following a
  // link keeps it where the operator is already looking; a page ASKING for a window gets
  // one, because that is what sign-in flows do and they answer back to whoever opened them.
  return viaWindowOpen ? 'child' : 'view'
}
