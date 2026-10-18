import { test, expect } from '@playwright/test'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// What closing a view does in Electron 43.4.1 – the two answers putting an account to sleep is
// built on, held here so an upgrade of Electron that changes either is caught by a test rather than
// by the operator. The measurement itself is probes/close-probe.mjs, run in a bare Electron
// process: Playwright, attached to every page of the application under test, would take a real
// beforeunload for a dialog of its own (run 38990782830). Every result is printed, so the log of a
// run carries the numbers as well as the verdict.

const require = createRequire(import.meta.url)
const ELECTRON = require('electron')
const PROBE = fileURLToPath(new URL('./probes/close-probe.mjs', import.meta.url))
const PROBE_LIMIT_MS = 120000

let results

test.beforeAll(async () => {
  test.setTimeout(PROBE_LIMIT_MS + 30000)
  const dataDir = await mkdtemp(path.join(tmpdir(), 'mhub-close-probe-'))
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const probe = spawn(ELECTRON, [PROBE, `--user-data-dir=${dataDir}`], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  probe.stdout.on('data', (chunk) => {
    output += chunk
  })
  probe.stderr.on('data', () => {})
  const ended = await Promise.race([
    new Promise((exited) => probe.on('exit', () => exited('exited'))),
    new Promise((over) => setTimeout(() => over('stuck'), PROBE_LIMIT_MS)),
  ])
  if (ended === 'stuck') probe.kill()
  await rm(dataDir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})

  const line = output.split(/\r?\n/).find((candidate) => candidate.startsWith('CLOSE-PROBE '))
  results = line ? JSON.parse(line.slice('CLOSE-PROBE '.length)) : null
  console.log(line ?? `CLOSE-PROBE produced no result (${ended}): ${output.slice(0, 2000)}`)
})

const named = (record, name) => (record?.events ?? []).filter((event) => event.name === name)

test('the probe ran to the end', () => {
  expect(results, 'the probe printed its result').not.toBeNull()
  expect(results.error ?? null).toBeNull()
  expect(results.timedOut ?? false).toBe(false)
})

// The application announces a crash on render-process-gone, a hang on unresponsive and a failed
// load on did-fail-load with any code but an abort. A close that reported any of them would put a
// false alarm on the status bar every time an account fell asleep.
for (const name of ['close', 'close-hidden', 'wait-plain', 'close-guard', 'close-while-loading']) {
  test(`${name}: closing reports no crash, no hang and no failed load`, () => {
    const record = results?.cases?.[name]
    expect(record, JSON.stringify(record)).toBeTruthy()
    expect(named(record, 'render-process-gone'), JSON.stringify(record)).toEqual([])
    expect(named(record, 'unresponsive'), JSON.stringify(record)).toEqual([])
    const announced = named(record, 'did-fail-load').filter((event) => event.isMainFrame && event.code !== -3)
    expect(announced, JSON.stringify(record)).toEqual([])
    expect(record.destroyed, JSON.stringify(record)).toBe(true)
  })
}

// Decision 9: a draft is protected by sleep only if a page can refuse the close.
for (const name of ['wait-guard', 'wait-guard-hidden']) {
  test(`${name}: a page holding a draft can refuse close({ waitForBeforeUnload: true })`, () => {
    const record = results?.cases?.[name]
    expect(named(record, 'will-prevent-unload').length, JSON.stringify(record)).toBeGreaterThan(0)
    expect(record.destroyed, JSON.stringify(record)).toBe(false)
  })
}

test('the refusal can be overridden, and the view then closes', () => {
  const record = results?.cases?.['wait-guard-overridden']
  expect(named(record, 'will-prevent-unload').length, JSON.stringify(record)).toBeGreaterThan(0)
  expect(record.destroyed, JSON.stringify(record)).toBe(true)
})

test('a plain close asks the page nothing', () => {
  const record = results?.cases?.['close-guard']
  expect(named(record, 'will-prevent-unload'), JSON.stringify(record)).toEqual([])
  expect(record.destroyed, JSON.stringify(record)).toBe(true)
})

// Woken while a service worker still holds the old process: the new page has to work.
test('an account woken during the service worker tail loads and stays alive', () => {
  const record = results?.cases?.['service-worker-wake']
  expect(record?.workerReady, JSON.stringify(record)).toBe(true)
  expect(record.newStillAlive, JSON.stringify(record)).toBe(true)
  expect(named({ events: record.closeEvents }, 'render-process-gone'), JSON.stringify(record)).toEqual([])
})
