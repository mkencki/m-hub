import { readdir as readDirectory, stat as statFile } from 'node:fs/promises'
import path from 'node:path'

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const COMMIT = /^[0-9a-f]{7,40}$/i

// What a bug report needs and a person cannot otherwise get at: which build this is, and what
// it runs on. Everything is read from the manifest electron-builder packed or asked of the
// process; nothing is guessed. A run from the sources has no build date and no commit, and
// says so, rather than showing the date the sources were last touched.
//
// The date and the commit arrive from CI through electron-builder's command-line coercion,
// which turns anything that looks like a number into one. A value that does not read as a
// date or as a hash is left out rather than shown as one: a build with no provenance beats a
// build with a wrong one.
export function describeBuild(manifest, versions, packaged) {
  const buildDate =
    typeof manifest.buildDate === 'string' && ISO_DATE.test(manifest.buildDate) ? manifest.buildDate : null
  const commit =
    typeof manifest.commit === 'string' && COMMIT.test(manifest.commit)
      ? manifest.commit.slice(0, 7).toLowerCase()
      : null
  return {
    version: String(manifest.version ?? ''),
    buildDate,
    commit,
    packaged: Boolean(packaged),
    electron: versions.electron ?? '',
    chrome: versions.chrome ?? '',
  }
}

// Every byte under the profile: the sessions, Chromium's caches, the log, the attachments.
// Measured 2026-09-07 on the operator's own profile: 843.5 MB in 3366 files under 183
// directories, 772 ms when walked synchronously – which is why this is async, and why the
// settings dialog asks for it on its own channel after it is already open.
//
// The walk is over a live directory. Chromium writes and deletes cache files while it is on,
// so an entry that is gone by the time it is measured is skipped, not fatal. Links are not
// followed: a junction pointing back up the tree would otherwise be walked forever, and what
// it points at is not the profile's own bytes anyway.
export async function directorySize(dir, { readdir = readDirectory, stat = statFile } = {}) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }

  const sizes = await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(dir, entry.name)
      if (entry.isSymbolicLink()) return 0
      if (entry.isDirectory()) return directorySize(full, { readdir, stat })
      if (!entry.isFile()) return 0
      try {
        return (await stat(full)).size
      } catch {
        return 0
      }
    }),
  )
  return sizes.reduce((total, size) => total + size, 0)
}
