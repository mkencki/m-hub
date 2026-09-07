import { describe, test, expect } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describeBuild, directorySize } from '../src/main/about.js'

const versions = { electron: '43.4.1', chrome: '140.0.7339.80', node: '24.9.0' }

describe('describeBuild', () => {
  test('a run from source carries the version and no build', () => {
    expect(describeBuild({ version: '0.5.7' }, versions, false)).toEqual({
      version: '0.5.7',
      buildDate: null,
      commit: null,
      packaged: false,
      electron: '43.4.1',
      chrome: '140.0.7339.80',
    })
  })

  test('a CI build carries the date and the first seven characters of the commit', () => {
    const built = describeBuild(
      { version: '0.5.7', buildDate: '2026-09-07', commit: '0123456789abcdef0123456789abcdef01234567' },
      versions,
      true,
    )
    expect(built).toMatchObject({ buildDate: '2026-09-07', commit: '0123456', packaged: true })
  })

  // What CI passes goes through electron-builder's own command-line coercion, and whatever
  // comes out is shown to the operator as a date and a commit. A value that is not one is
  // left out rather than displayed as one.
  test('a build date that is not a date, and a commit that is not a hash, are left out', () => {
    const built = describeBuild({ version: '0.5.7', buildDate: 'yesterday', commit: 1.2345e39 }, versions, true)
    expect(built.buildDate).toBeNull()
    expect(built.commit).toBeNull()
  })
})

describe('directorySize', () => {
  test('adds up every file in every subdirectory', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'mhub-about-'))
    try {
      await writeFile(path.join(dir, 'accounts.json'), 'x'.repeat(10))
      await mkdir(path.join(dir, 'att', 'deep'), { recursive: true })
      await writeFile(path.join(dir, 'att', 'clip.mp4'), 'y'.repeat(300))
      await writeFile(path.join(dir, 'att', 'deep', 'c'), 'z'.repeat(5))

      expect(await directorySize(dir)).toBe(315)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('a directory that is not there measures zero rather than throwing', async () => {
    expect(await directorySize(path.join(tmpdir(), `mhub-about-nowhere-${Date.now()}`))).toBe(0)
  })

  // A profile is a live thing: Chromium writes and deletes cache files while the walk is on.
  // A file that is gone by the time it is measured is simply not there, and the rest of the
  // walk goes on.
  test('a file that vanishes mid-walk is skipped and the walk carries on', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'mhub-about-'))
    try {
      await writeFile(path.join(dir, 'gone'), 'x'.repeat(100))
      await writeFile(path.join(dir, 'kept'), 'y'.repeat(7))
      const { stat } = await import('node:fs/promises')
      const vanishing = (file) =>
        file.endsWith('gone') ? Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })) : stat(file)

      expect(await directorySize(dir, { stat: vanishing })).toBe(7)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  // A junction pointing back up the tree would be walked forever. Links are not followed:
  // they are not the profile's own bytes, and the profile has no business containing any.
  test('a link is neither followed nor counted', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'mhub-about-'))
    try {
      await mkdir(path.join(dir, 'real'))
      await writeFile(path.join(dir, 'real', 'file'), 'x'.repeat(12))
      await symlink(dir, path.join(dir, 'real', 'loop'), 'junction')

      expect(await directorySize(dir)).toBe(12)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
