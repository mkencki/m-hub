import { describe, test, expect } from 'vitest'
import { accountMemoryMb, appMemoryMb, processIdsOf } from '../src/main/account-memory.js'

// Putting accounts to sleep is worth building only if an awake account costs enough to matter,
// and that has never been measured here. These two pieces turn the process table Electron
// reports into one number per account, which the log then records over ordinary days of work.

// What app.getAppMetrics() returns, trimmed to what is read. Memory is in kilobytes.
const metric = (pid, privateBytes) => ({ pid, memory: { workingSetSize: privateBytes * 2, privateBytes } })

describe('processIdsOf', () => {
  // A page's iframes may run in processes of their own – a cross-site embed does – and that
  // memory is the account's as much as the main renderer's.
  test('is the renderer and every process its frames run in, each once', () => {
    const webContents = {
      getOSProcessId: () => 100,
      mainFrame: { framesInSubtree: [{ osProcessId: 100 }, { osProcessId: 200 }, { osProcessId: 200 }] },
    }
    expect(processIdsOf(webContents).sort()).toEqual([100, 200])
  })

  // A view whose renderer has not started yet, or has just gone, has no process to count.
  test('leaves out a process that is not there', () => {
    const webContents = { getOSProcessId: () => 0, mainFrame: null }
    expect(processIdsOf(webContents)).toEqual([])
  })
})

describe('accountMemoryMb', () => {
  test('adds up the private memory of those processes, in whole megabytes', () => {
    const metrics = [metric(100, 150 * 1024), metric(200, 30 * 1024 + 700), metric(300, 999 * 1024)]
    expect(accountMemoryMb(metrics, [100, 200])).toBe(181)
  })

  // privateBytes is reported on Windows only. Elsewhere there is nothing to add, and saying zero
  // would read as an account that costs nothing.
  test('says nothing when the platform does not report private memory', () => {
    const metrics = [{ pid: 100, memory: { workingSetSize: 4096 } }]
    expect(accountMemoryMb(metrics, [100])).toBeNull()
  })

  test('says nothing for an account with no process found', () => {
    expect(accountMemoryMb([metric(100, 1024)], [400])).toBeNull()
  })
})

// What putting an account to sleep gives back is read off the whole application, before and after:
// the account's own processes are not all of it – the browser process keeps a little of every
// session – and a migrating number in one process is no gain at all.
describe('appMemoryMb', () => {
  test('adds up the private memory of every process the application has', () => {
    expect(appMemoryMb([metric(1, 100 * 1024), metric(2, 50 * 1024), metric(3, 512)])).toBe(151)
  })

  test('says nothing when the platform does not report private memory', () => {
    expect(appMemoryMb([{ pid: 1, memory: { workingSetSize: 4096 } }])).toBeNull()
  })
})
