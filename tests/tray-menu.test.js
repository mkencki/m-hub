import { describe, test, expect } from 'vitest'
import { trayMenuTemplate } from '../src/main/tray-menu.js'
import { t } from '../src/shared/i18n.js'

const en = (key, params) => t('en', key, params)
const pl = (key, params) => t('pl', key, params)
const state = { autoStart: false, canSleepOthers: true, anyAsleep: true }
const item = (template, id) => template.find((entry) => entry.id === id)

describe('the tray menu', () => {
  test('offers the window, then the accounts, then the start with Windows and the log, then quitting', () => {
    const order = trayMenuTemplate({ ...state, tr: en }).map((entry) => entry.id ?? entry.type)
    expect(order).toEqual(['show', 'separator', 'sleep-others', 'wake-all', 'separator', 'auto-start', 'open-logs', 'separator', 'quit'])
  })

  // The same rule as in the channel menu: offered only when there is somebody to put to sleep.
  test('putting the others to sleep needs someone else awake', () => {
    expect(item(trayMenuTemplate({ ...state, canSleepOthers: true, tr: en }), 'sleep-others').enabled).toBe(true)
    expect(item(trayMenuTemplate({ ...state, canSleepOthers: false, tr: en }), 'sleep-others').enabled).toBe(false)
  })

  test('waking needs someone asleep', () => {
    expect(item(trayMenuTemplate({ ...state, anyAsleep: true, tr: en }), 'wake-all').enabled).toBe(true)
    expect(item(trayMenuTemplate({ ...state, anyAsleep: false, tr: en }), 'wake-all').enabled).toBe(false)
  })

  test('the start with Windows is a box showing how things stand', () => {
    const on = item(trayMenuTemplate({ ...state, autoStart: true, tr: en }), 'auto-start')
    expect(on).toMatchObject({ type: 'checkbox', checked: true })
    expect(item(trayMenuTemplate({ ...state, autoStart: false, tr: en }), 'auto-start').checked).toBe(false)
  })

  test('labels its items in the interface language', () => {
    const template = trayMenuTemplate({ ...state, tr: pl })
    expect(item(template, 'show').label).toBe('Pokaż')
    expect(item(template, 'sleep-others').label).toBe('Uśpij wszystkie oprócz bieżącego')
    expect(item(template, 'wake-all').label).toBe('Obudź wszystkie konta')
    expect(item(template, 'quit').label).toBe('Zakończ')
    expect(item(trayMenuTemplate({ ...state, tr: en }), 'wake-all').label).toBe('Wake all accounts')
  })
})
